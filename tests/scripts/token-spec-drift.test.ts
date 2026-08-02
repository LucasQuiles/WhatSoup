import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-token-spec-drift.mjs');

const tmp = trackTmpDirs('token-spec-');

function makeFixture(spec: string, css: string) {
  const dir = tmp.make('drift');
  const specPath = join(dir, 'tokens-v3.md');
  const tokensPath = join(dir, 'tokens.semantic.css');
  writeFileSync(specPath, spec);
  writeFileSync(tokensPath, css);
  return { specPath, tokensPath };
}

function fixtureSpec() {
  return `
# Tokens v3

### 2.7 Channel-tint strengths

| Token | Dark | Light |
|---|---|---|
| \`--wash\` | 12% | 9% |
| \`--chan-border\` | 36% | 32% |

### 2.8 Color ramps

| Token | Dark | Light |
|---|---|---|
| \`--ramp-blue-1\` | \`#000001\` | \`#FFFFFE\` |

## 3. Semantic layer

### 3.1 Surface ladder

| Token | Dark | Light |
|---|---|---|
| \`--surface-base\` | \`#0E1013\` | \`#FAFAFA\` |

### 3.4 Action accent

| Token | Dark | Light |
|---|---|---|
| \`--accent\` | \`#6BA6FF\` | \`#2563EB\` |
| \`--accent-wash\` | \`color-mix(in srgb, var(--accent) 12%, transparent)\` | same formula at 9% |

### 3.5 Status channels

| Token | Dark | Light |
|---|---|---|
| \`--status-ok-solid\` | \`#5BD97B\` | \`#15722F\` |
| \`--status-warn-solid\` | \`#F5B54A\` | \`#855900\` |
| \`--status-crit-solid\` | \`#F4736F\` | \`#B42318\` |
| \`--status-{ok,warn,crit}-fg\` | = solid | = solid |
| \`--status-{ok,warn,crit}-wash\` | derived | derived |
| \`--status-{ok,warn,crit}-border\` | derived | derived |

### 3.6 Mode channels

| Token | Dark | Light |
|---|---|---|
| \`--mode-passive-solid\` | \`#3BD6B0\` | \`#096853\` |
| \`--mode-chat-solid\` | \`#45C9E8\` | \`#0A6E8C\` |
| \`--mode-agent-solid\` | \`#A78BFA\` | \`#6841D6\` |
| \`--mode-{passive,chat,agent}-fg\` | = solid | = solid |
| \`--mode-{passive,chat,agent}-wash\` / \`-border\` | derived | derived |

## 4. Component layer

| Token | Value | Owner |
|---|---|---|
| \`--btn-h\` | \`32px\` | Button |
`;
}

function fixtureCss(overrides = '') {
  return `
:root,
[data-theme="dark"] {
  --surface-base: #0E1013;
  --accent: #6BA6FF;
  --accent-wash: color-mix(in srgb, var(--accent) 12%, transparent);
  --wash: 12%;
  --chan-border: 36%;
  --status-ok-solid: #5BD97B;
  --status-ok-fg: #5BD97B;
  --status-ok-wash: color-mix(in srgb, var(--status-ok-solid) var(--wash), transparent);
  --status-ok-border: color-mix(in srgb, var(--status-ok-solid) var(--chan-border), transparent);
  --status-warn-solid: #F5B54A;
  --status-warn-fg: #F5B54A;
  --status-warn-wash: color-mix(in srgb, var(--status-warn-solid) var(--wash), transparent);
  --status-warn-border: color-mix(in srgb, var(--status-warn-solid) var(--chan-border), transparent);
  --status-crit-solid: #F4736F;
  --status-crit-fg: #F4736F;
  --status-crit-wash: color-mix(in srgb, var(--status-crit-solid) var(--wash), transparent);
  --status-crit-border: color-mix(in srgb, var(--status-crit-solid) var(--chan-border), transparent);
  --mode-passive-solid: #3BD6B0;
  --mode-passive-fg: #3BD6B0;
  --mode-passive-wash: color-mix(in srgb, var(--mode-passive-solid) var(--wash), transparent);
  --mode-passive-border: color-mix(in srgb, var(--mode-passive-solid) var(--chan-border), transparent);
  --mode-chat-solid: #45C9E8;
  --mode-chat-fg: #45C9E8;
  --mode-chat-wash: color-mix(in srgb, var(--mode-chat-solid) var(--wash), transparent);
  --mode-chat-border: color-mix(in srgb, var(--mode-chat-solid) var(--chan-border), transparent);
  --mode-agent-solid: #A78BFA;
  --mode-agent-fg: #A78BFA;
  --mode-agent-wash: color-mix(in srgb, var(--mode-agent-solid) var(--wash), transparent);
  --mode-agent-border: color-mix(in srgb, var(--mode-agent-solid) var(--chan-border), transparent);
  ${overrides}
}

[data-theme="light"] {
  --surface-base: #FAFAFA;
  --accent: #2563EB;
  --accent-wash: color-mix(in srgb, var(--accent) var(--wash), transparent);
  --wash: 9%;
  --chan-border: 32%;
  --status-ok-solid: #15722F;
  --status-ok-fg: #15722F;
  --status-ok-wash: color-mix(in srgb, var(--status-ok-solid) var(--wash), transparent);
  --status-ok-border: color-mix(in srgb, var(--status-ok-solid) var(--chan-border), transparent);
  --status-warn-solid: #855900;
  --status-warn-fg: #855900;
  --status-warn-wash: color-mix(in srgb, var(--status-warn-solid) var(--wash), transparent);
  --status-warn-border: color-mix(in srgb, var(--status-warn-solid) var(--chan-border), transparent);
  --status-crit-solid: #B42318;
  --status-crit-fg: #B42318;
  --status-crit-wash: color-mix(in srgb, var(--status-crit-solid) var(--wash), transparent);
  --status-crit-border: color-mix(in srgb, var(--status-crit-solid) var(--chan-border), transparent);
  --mode-passive-solid: #096853;
  --mode-passive-fg: #096853;
  --mode-passive-wash: color-mix(in srgb, var(--mode-passive-solid) var(--wash), transparent);
  --mode-passive-border: color-mix(in srgb, var(--mode-passive-solid) var(--chan-border), transparent);
  --mode-chat-solid: #0A6E8C;
  --mode-chat-fg: #0A6E8C;
  --mode-chat-wash: color-mix(in srgb, var(--mode-chat-solid) var(--wash), transparent);
  --mode-chat-border: color-mix(in srgb, var(--mode-chat-solid) var(--chan-border), transparent);
  --mode-agent-solid: #6841D6;
  --mode-agent-fg: #6841D6;
  --mode-agent-wash: color-mix(in srgb, var(--mode-agent-solid) var(--wash), transparent);
  --mode-agent-border: color-mix(in srgb, var(--mode-agent-solid) var(--chan-border), transparent);
}
`;
}

function runScript(specPath: string, tokensPath: string) {
  return spawnSync(
    'node',
    [SCRIPT, '--spec', specPath, '--tokens', tokensPath],
    {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function parsedOutput(result: ReturnType<typeof runScript>) {
  return JSON.parse(result.stdout) as {
    checked_count: number;
    failures: Array<{ code: string; theme: string; token: string }>;
    verdict: 'PASS' | 'FAIL';
  };
}

describe('check-token-spec-drift.mjs', () => {
  it('passes explicit and derived semantic token values', () => {
    const fixture = makeFixture(fixtureSpec(), fixtureCss());
    const result = runScript(fixture.specPath, fixture.tokensPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.failures).toEqual([]);
    expect(output.checked_count).toBeGreaterThan(30);
  });

  it('fails when a semantic token value drifts from the spec', () => {
    const fixture = makeFixture(fixtureSpec(), fixtureCss('  --surface-base: #111111;'));
    const result = runScript(fixture.specPath, fixture.tokensPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.failures).toContainEqual(
      expect.objectContaining({
        code: 'VALUE_DRIFT',
        theme: 'dark',
        token: '--surface-base',
      }),
    );
  });

  it('fails when a semantic token is missing from one theme', () => {
    const fixture = makeFixture(
      fixtureSpec(),
      fixtureCss().replace(/\n  --mode-agent-border: color-mix\(in srgb, var\(--mode-agent-solid\) var\(--chan-border\), transparent\);/, ''),
    );
    const result = runScript(fixture.specPath, fixture.tokensPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.failures).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_TOKEN',
        token: '--mode-agent-border',
      }),
    );
  });

  it('does not accept a missing token from a CSS comment', () => {
    const fixture = makeFixture(
      fixtureSpec(),
      fixtureCss()
        .replace('\n  --surface-base: #0E1013;', '\n  /* --surface-base: #0E1013; */'),
    );
    const result = runScript(fixture.specPath, fixture.tokensPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.failures).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_TOKEN',
        theme: 'dark',
        token: '--surface-base',
      }),
    );
  });

  it('does not report drift from a stale CSS comment', () => {
    const fixture = makeFixture(fixtureSpec(), fixtureCss('  /* --surface-base: #111111; */'));
    const result = runScript(fixture.specPath, fixture.tokensPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.failures).toEqual([]);
  });

  it('does not treat primitive or component tables as semantic CSS requirements', () => {
    const fixture = makeFixture(fixtureSpec(), fixtureCss());
    const result = runScript(fixture.specPath, fixture.tokensPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.failures.some((failure) => failure.token === '--ramp-blue-1')).toBe(false);
    expect(output.failures.some((failure) => failure.token === '--btn-h')).toBe(false);
  });

  it('passes the live repository semantic token contract', () => {
    const result = spawnSync('node', [SCRIPT], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = JSON.parse(result.stdout) as { checked_count: number; verdict: 'PASS' | 'FAIL' };

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.checked_count).toBeGreaterThan(90);
  });
});
