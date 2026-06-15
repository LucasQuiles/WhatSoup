#!/usr/bin/env node
// Verify that per-theme semantic token values in tokens.semantic.css match
// the authoritative token tables in docs/design-system/03-spec/tokens-v3.md.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');
const repoRoot = resolve(consoleRoot, '..');

const DEFAULT_SPEC = resolve(repoRoot, 'docs/design-system/03-spec/tokens-v3.md');
const DEFAULT_TOKENS = resolve(consoleRoot, 'src/styles/tokens.semantic.css');

const STATUS_IDS = ['ok', 'warn', 'crit'];
const MODE_IDS = ['passive', 'chat', 'agent'];

function usage() {
  return `Usage: node console/scripts/check-token-spec-drift.mjs [options]

Options:
  --spec <path>     Token spec markdown. Default: docs/design-system/03-spec/tokens-v3.md
  --tokens <path>   Semantic token CSS file. Default: console/src/styles/tokens.semantic.css
  --help            Print this message.
`;
}

function parseArgs(argv) {
  const opts = { help: false, spec: DEFAULT_SPEC, tokens: DEFAULT_TOKENS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--spec') opts.spec = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--tokens') opts.tokens = resolve(requireValue(argv, ++i, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function normalize(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function firstCodeValue(cell) {
  return /`([^`]+)`/.exec(cell)?.[1] ?? null;
}

function splitRow(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function setExpected(expected, theme, token, value, source) {
  expected[theme][token] = { source, value: normalize(value) };
}

function expandSpecRow(expected, cells, lineNumber) {
  if (cells.length < 3) return;
  const [tokenCell, darkCell, lightCell] = cells;
  const source = `tokens-v3.md:${lineNumber}`;

  if (tokenCell === '`--wash`') {
    setExpected(expected, 'dark', '--wash', firstCodeValue(darkCell) ?? darkCell, source);
    setExpected(expected, 'light', '--wash', firstCodeValue(lightCell) ?? lightCell, source);
    return;
  }
  if (tokenCell === '`--chan-border`') {
    setExpected(expected, 'dark', '--chan-border', firstCodeValue(darkCell) ?? darkCell, source);
    setExpected(expected, 'light', '--chan-border', firstCodeValue(lightCell) ?? lightCell, source);
    return;
  }

  if (tokenCell === '`--status-{ok,warn,crit}-fg`') {
    for (const id of STATUS_IDS) {
      const solid = `--status-${id}-solid`;
      for (const theme of ['dark', 'light']) {
        if (!expected[theme][solid]) throw new Error(`${source}: ${tokenCell} appears before ${solid}`);
        setExpected(expected, theme, `--status-${id}-fg`, expected[theme][solid].value, source);
      }
    }
    return;
  }
  if (tokenCell === '`--status-{ok,warn,crit}-wash`') {
    for (const id of STATUS_IDS) {
      for (const theme of ['dark', 'light']) {
        setExpected(
          expected,
          theme,
          `--status-${id}-wash`,
          `color-mix(in srgb, var(--status-${id}-solid) var(--wash), transparent)`,
          source,
        );
      }
    }
    return;
  }
  if (tokenCell === '`--status-{ok,warn,crit}-border`') {
    for (const id of STATUS_IDS) {
      for (const theme of ['dark', 'light']) {
        setExpected(
          expected,
          theme,
          `--status-${id}-border`,
          `color-mix(in srgb, var(--status-${id}-solid) var(--chan-border), transparent)`,
          source,
        );
      }
    }
    return;
  }

  if (tokenCell === '`--mode-{passive,chat,agent}-fg`') {
    for (const id of MODE_IDS) {
      const solid = `--mode-${id}-solid`;
      for (const theme of ['dark', 'light']) {
        if (!expected[theme][solid]) throw new Error(`${source}: ${tokenCell} appears before ${solid}`);
        setExpected(expected, theme, `--mode-${id}-fg`, expected[theme][solid].value, source);
      }
    }
    return;
  }
  if (tokenCell === '`--mode-{passive,chat,agent}-wash` / `-border`') {
    for (const id of MODE_IDS) {
      for (const theme of ['dark', 'light']) {
        setExpected(
          expected,
          theme,
          `--mode-${id}-wash`,
          `color-mix(in srgb, var(--mode-${id}-solid) var(--wash), transparent)`,
          source,
        );
        setExpected(
          expected,
          theme,
          `--mode-${id}-border`,
          `color-mix(in srgb, var(--mode-${id}-solid) var(--chan-border), transparent)`,
          source,
        );
      }
    }
    return;
  }

  const token = firstCodeValue(tokenCell);
  if (!token?.startsWith('--')) return;
  const darkValue = firstCodeValue(darkCell);
  let lightValue = firstCodeValue(lightCell);
  if (!darkValue) return;

  if (token === '--accent-wash' && !lightValue && /same formula at 9%/.test(lightCell)) {
    lightValue = 'color-mix(in srgb, var(--accent) var(--wash), transparent)';
  }
  if (!lightValue) return;

  setExpected(expected, 'dark', token, darkValue, source);
  setExpected(expected, 'light', token, lightValue, source);
}

function parseSpecExpected(markdown) {
  const expected = { dark: {}, light: {} };
  const lines = markdown.split(/\r?\n/);
  let section = 'outside';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('### 2.7 Channel-tint strengths')) section = 'channel-strengths';
    else if (line.startsWith('### 2.8 ')) section = 'outside';
    else if (line.startsWith('## 3. Semantic layer')) section = 'semantic';
    else if (line.startsWith('## 4. Component layer')) section = 'outside';

    if (section === 'outside') continue;
    if (!line.startsWith('|')) continue;
    expandSpecRow(expected, splitRow(line), i + 1);
  }

  const count = Object.keys(expected.dark).length;
  if (count === 0 || Object.keys(expected.light).length === 0) {
    throw new Error('tokens-v3.md yielded zero per-theme expected tokens');
  }
  return expected;
}

function selectorOwnsTheme(selector, theme) {
  if (theme === 'dark') return selector.includes('[data-theme="dark"]');
  return selector.includes('[data-theme="light"]');
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseThemeTokens(css, theme) {
  const tokens = {};
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  const uncommentedCss = stripCssComments(css);
  let match;
  while ((match = blockRe.exec(uncommentedCss)) !== null) {
    const selector = match[1].trim();
    if (!selectorOwnsTheme(selector, theme)) continue;
    for (const decl of match[2].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      tokens[`--${decl[1]}`] = normalize(decl[2]);
    }
  }
  return tokens;
}

function compare(expected, actualByTheme) {
  const failures = [];
  for (const theme of ['dark', 'light']) {
    for (const [token, spec] of Object.entries(expected[theme])) {
      const actual = actualByTheme[theme][token];
      if (!actual) {
        failures.push({
          code: 'MISSING_TOKEN',
          expected: spec.value,
          source: spec.source,
          theme,
          token,
        });
      } else if (actual !== spec.value) {
        failures.push({
          actual,
          code: 'VALUE_DRIFT',
          expected: spec.value,
          source: spec.source,
          theme,
          token,
        });
      }
    }
  }
  return failures;
}

function buildReport(specMarkdown, tokenCss, paths) {
  const expected = parseSpecExpected(specMarkdown);
  const actualByTheme = {
    dark: parseThemeTokens(tokenCss, 'dark'),
    light: parseThemeTokens(tokenCss, 'light'),
  };
  const failures = compare(expected, actualByTheme);

  return {
    checked_count: Object.keys(expected.dark).length + Object.keys(expected.light).length,
    failures,
    generated_at_utc: new Date().toISOString(),
    paths,
    schema_version: 1,
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

  const report = buildReport(
    readFileSync(opts.spec, 'utf8'),
    readFileSync(opts.tokens, 'utf8'),
    { spec: opts.spec, tokens: opts.tokens },
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== 'PASS') process.exit(1);
}

main();
