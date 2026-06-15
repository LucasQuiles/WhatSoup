import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-theme-parity.mjs');

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// Flat single-block scopes — the script's parser is `([^{}]+)\{([^{}]*)\}`, which
// does not nest, so fixtures use the same flat shape as the real token file.
function makeFixture(css: string) {
  const root = mkdtempSync(join(tmpdir(), 'theme-parity-'));
  tmpDirs.push(root);
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
    expect(result.stderr).toContain('empty or unparseable scan');
    expect(result.stdout).not.toContain('theme parity OK');
  });

  it('fails closed (exit 2) when tokens exist but no [data-theme] blocks match', () => {
    // Tokens are present but live under a non-theme selector, so both scopes parse
    // zero tokens — the structural shape the guard is meant to catch.
    const file = makeFixture('.panel { --a: #000; --b: #111; }\n:root { --c: #222; }\n');
    const result = run(['--file', file]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('empty or unparseable scan');
    expect(result.stdout).not.toContain('theme parity OK');
  });
});
