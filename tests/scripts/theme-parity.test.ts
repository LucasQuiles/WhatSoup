import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-theme-parity.mjs');

const tmp = trackTmpDirs('');

// Flat single-block scopes — the script's parser is `([^{}]+)\{([^{}]*)\}`, which
// does not nest, so fixtures use the same flat shape as the real token file.
function makeFixture(css: string) {
  const root = tmp.make('theme-parity');
  const file = join(root, 'tokens.semantic.css');
  writeFileSync(file, css);
  return file;
}

function run(args: string[] = []) {
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('check-theme-parity.mjs', () => {
  it('passes on the real semantic token file with the default (no-flag) invocation', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^theme parity OK: \d+ semantic tokens defined in both dark and light scopes\n$/);
  });

  it('passes a fixture whose dark and light scopes define the same tokens', () => {
    const file = makeFixture(
      ':root, [data-theme="dark"] { --a: #000; --b: #111; }\n' +
      '[data-theme="light"] { --a: #fff; --b: #eee; }\n',
    );
    const result = run(['--file', file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('theme parity OK: 2 semantic tokens');
  });

  it('fails a fixture with a token defined in dark but missing in light', () => {
    const file = makeFixture(
      ':root, [data-theme="dark"] { --a: #000; --only-dark: #222; }\n' +
      '[data-theme="light"] { --a: #fff; }\n',
    );
    const result = run(['--file', file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('defined in dark but missing in light');
    expect(result.stderr).toContain('--only-dark');
  });

  it('fails a fixture with a token defined in light but missing in dark', () => {
    const file = makeFixture(
      ':root, [data-theme="dark"] { --a: #000; }\n' +
      '[data-theme="light"] { --a: #fff; --only-light: #eee; }\n',
    );
    const result = run(['--file', file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('defined in light but missing in dark');
    expect(result.stderr).toContain('--only-light');
  });

  // Fail-closed: an empty scan must not vacuously report "parity OK". Before the
  // dark.size===0 && light.size===0 guard, an emptied/renamed/parse-broken token
  // file fell through to exit 0 with "OK: 0 semantic tokens" — a silent fail-open.
  it('fails closed (exit 2) on an empty file — no theme scopes parsed', () => {
    const file = makeFixture('');
    const result = run(['--file', file]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('degenerate scan');
    expect(result.stdout).not.toContain('theme parity OK');
  });

  it('fails closed (exit 2) when tokens exist but no [data-theme] blocks match', () => {
    // Tokens are present but live under a non-theme selector, so no theme-specific block
    // is seen — the structural shape the guard is meant to catch.
    const file = makeFixture('.panel { --a: #000; --b: #111; }\n:root { --c: #222; }\n');
    const result = run(['--file', file]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('degenerate scan');
    expect(result.stdout).not.toContain('theme parity OK');
  });

  // [adversarial Hole 1] A comment whose TEXT contains `[data-theme="dark"]{...}` must not be
  // parsed as a real block. Before comment-stripping, the phantom tokens made both scopes
  // non-empty and the parity diff compared phantom-vs-phantom → vacuous exit-0 PASS.
  it('fails closed (exit 2) when only a comment carries theme selectors (phantom tokens)', () => {
    const file = makeFixture(
      '/* [data-theme="dark"]{--x:1} [data-theme="light"]{--x:1} */\n' +
      '[data-theme="dark"] { }\n[data-theme="light"] { }\n',
    );
    const result = run(['--file', file]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('degenerate scan');
    expect(result.stdout).not.toContain('theme parity OK');
  });

  // [adversarial Hole 2] A shared `:root,[data-theme="dark"],[data-theme="light"]` alias block
  // (the live token file ships one) trivially balances parity on its own. If the two real
  // per-theme blocks are emptied/lost but the shared block survives, dark===light (non-empty)
  // and a naive guard passes. Requiring a theme-SPECIFIC block on each side refuses it.
  it('fails closed (exit 2) when only a shared dark+light alias block survives', () => {
    const file = makeFixture(
      ':root, [data-theme="dark"] { }\n' +
      '[data-theme="light"] { }\n' +
      ':root, [data-theme="dark"], [data-theme="light"] { --color-d0: var(--x); --b1: var(--y); }\n',
    );
    const result = run(['--file', file]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('degenerate scan');
    expect(result.stdout).not.toContain('theme parity OK');
  });
});
