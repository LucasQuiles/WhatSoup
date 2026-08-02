import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-contrast-matrix.mjs');

const tmp = trackTmpDirs('contrast-');

function makeFixture(css: string) {
  const dir = tmp.make('matrix');
  const tokensPath = join(dir, 'tokens.semantic.css');
  const outPath = join(dir, 'contrast-matrix.json');
  writeFileSync(tokensPath, css);
  return { dir, tokensPath, outPath };
}

function baseCss(overrides = '') {
  return `
:root,
[data-theme="dark"] {
  --surface-base: #000000;
  --surface-raised: #050505;
  --surface-overlay: #0A0A0A;
  --surface-inset: #000000;
  --text-1: #FFFFFF;
  --text-2: #D7DDE5;
  --text-3: #8A929E;
  --accent: #80B8FF;
  --accent-fg: #000000;
  --focus-ring: #80B8FF;
  --wash: 12%;
  --status-ok-fg: #70E08D;
  --status-ok-wash: color-mix(in srgb, var(--status-ok-fg) var(--wash), transparent);
  --status-warn-fg: #FFD27A;
  --status-warn-wash: color-mix(in srgb, var(--status-warn-fg) var(--wash), transparent);
  --status-crit-fg: #FF8A86;
  --status-crit-wash: color-mix(in srgb, var(--status-crit-fg) var(--wash), transparent);
  --mode-passive-fg: #62DFC1;
  --mode-passive-wash: color-mix(in srgb, var(--mode-passive-fg) var(--wash), transparent);
  --mode-chat-fg: #66D7F2;
  --mode-chat-wash: color-mix(in srgb, var(--mode-chat-fg) var(--wash), transparent);
  --mode-agent-fg: #BCA6FF;
  --mode-agent-wash: color-mix(in srgb, var(--mode-agent-fg) var(--wash), transparent);
  --provider-claude-fg: #C8B78A;
  --provider-claude-wash: color-mix(in srgb, var(--provider-claude-fg) var(--wash), transparent);
  --data-inbound-solid: #91C7FF;
  ${overrides}
}

[data-theme="light"] {
  --surface-base: #FFFFFF;
  --surface-raised: #FFFFFF;
  --surface-overlay: #FFFFFF;
  --surface-inset: #F3F4F6;
  --text-1: #111111;
  --text-2: #444B55;
  --text-3: #707782;
  --accent: #2458D3;
  --accent-fg: #FFFFFF;
  --focus-ring: #2458D3;
  --wash: 9%;
  --status-ok-fg: #126C2E;
  --status-ok-wash: color-mix(in srgb, var(--status-ok-fg) var(--wash), transparent);
  --status-warn-fg: #765000;
  --status-warn-wash: color-mix(in srgb, var(--status-warn-fg) var(--wash), transparent);
  --status-crit-fg: #A32117;
  --status-crit-wash: color-mix(in srgb, var(--status-crit-fg) var(--wash), transparent);
  --mode-passive-fg: #075D4D;
  --mode-passive-wash: color-mix(in srgb, var(--mode-passive-fg) var(--wash), transparent);
  --mode-chat-fg: #075F7C;
  --mode-chat-wash: color-mix(in srgb, var(--mode-chat-fg) var(--wash), transparent);
  --mode-agent-fg: #5730C8;
  --mode-agent-wash: color-mix(in srgb, var(--mode-agent-fg) var(--wash), transparent);
  --provider-claude-fg: #66512E;
  --provider-claude-wash: color-mix(in srgb, var(--provider-claude-fg) var(--wash), transparent);
  --data-inbound-solid: #2458D3;
}
`;
}

function runScript(tokensPath: string, outPath: string, extraArgs: string[] = []) {
  return spawnSync(
    'node',
    [SCRIPT, '--tokens', tokensPath, '--out', outPath, ...extraArgs],
    {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function parsedOutput(result: ReturnType<typeof runScript>) {
  return JSON.parse(result.stdout) as {
    failed_count: number;
    pair_count: number;
    rows: Array<{ pair: string; ratio: number | null; status: 'PASS' | 'FAIL'; type: string }>;
    skipped: Array<{ type: string }>;
    verdict: 'PASS' | 'FAIL';
  };
}

describe('check-contrast-matrix.mjs', () => {
  it('passes the binding token pairs and writes the artifact file', () => {
    const fixture = makeFixture(baseCss());
    const result = runScript(fixture.tokensPath, fixture.outPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.failed_count).toBe(0);
    expect(output.pair_count).toBeGreaterThan(60);
    expect(existsSync(fixture.outPath)).toBe(true);
    expect(JSON.parse(readFileSync(fixture.outPath, 'utf8')).verdict).toBe('PASS');
  });

  it('discovers provider text and data-series tokens', () => {
    const fixture = makeFixture(baseCss());
    const result = runScript(fixture.tokensPath, fixture.outPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.rows.some((row) => row.type === 'provider-text')).toBe(true);
    expect(output.rows.some((row) => row.type === 'provider-text-on-wash')).toBe(true);
    expect(output.rows.some((row) => row.type === 'data-non-text')).toBe(true);
  });

  it('records skipped provider/data discovery when future tokens are absent', () => {
    const css = baseCss()
      .replace(/\s+--provider-claude-fg:[^;]+;/g, '')
      .replace(/\s+--provider-claude-wash:[^;]+;/g, '')
      .replace(/\s+--data-inbound-solid:[^;]+;/g, '');
    const fixture = makeFixture(css);
    const result = runScript(fixture.tokensPath, fixture.outPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.skipped.filter((row) => row.type === 'provider')).toHaveLength(2);
    expect(output.skipped.filter((row) => row.type === 'data')).toHaveLength(2);
  });

  it('fails when a required text pair misses its threshold', () => {
    const fixture = makeFixture(baseCss('  --text-1: #111111;'));
    const result = runScript(fixture.tokensPath, fixture.outPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.rows.some((row) => row.status === 'FAIL' && row.pair === 'text-1 on surface-base')).toBe(true);
  });

  it('fails when a token pair cannot resolve', () => {
    const fixture = makeFixture(baseCss('  --accent: var(--missing-accent);'));
    const result = runScript(fixture.tokensPath, fixture.outPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.rows.some((row) => row.status === 'FAIL' && row.ratio === null)).toBe(true);
  });

  it('exits 2 with a named EMPTY_SCAN error when no [data-theme] token blocks are present', () => {
    // A CSS file with no [data-theme="dark"] or [data-theme="light"] blocks means
    // parseThemeTokens() returns {} — the script must refuse to PASS on a degenerate scan.
    const fixture = makeFixture(`
/* no theme blocks */
:root {
  --unrelated: #123456;
}
`);
    const result = runScript(fixture.tokensPath, fixture.outPath);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/EMPTY_SCAN/);
    expect(result.stderr).toMatch(/no \[data-theme\] tokens parsed/);
  });

  it('still passes and is byte-identical in exit/summary when run against the real token file', () => {
    // Guard: the empty-scan check must not affect the normal code path.
    const realTokens = resolve(process.cwd(), 'console/src/styles/tokens.semantic.css');
    const dir = tmp.make('matrix-real');
    const outPath = join(dir, 'contrast-matrix.json');
    const result = spawnSync(
      'node',
      [SCRIPT, '--tokens', realTokens, '--out', outPath, '--no-write'],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as { verdict: string; pair_count: number; failed_count: number };
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.failed_count).toBe(0);
    expect(parsed.pair_count).toBeGreaterThan(60);
  });
});
