import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function catchClause(body: string): string {
  return ['catch', ' {', body, '}'].join('');
}

function makeFixture(source: string, baseline: string): string {
  const root = mkdtempSync(join(tmpdir(), 'catch-ratchet-generator-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  cpSync(
    join(REPO_ROOT, 'scripts/generate-catch-ratchet.mjs'),
    join(root, 'scripts/generate-catch-ratchet.mjs'),
  );
  cpSync(join(REPO_ROOT, 'eslint-rules'), join(root, 'eslint-rules'), {
    recursive: true,
  });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'src/probe.ts'), source);
  writeFileSync(join(root, 'eslint-rules/catch-ratchet-baseline.json'), baseline);
  return root;
}

function runGenerator(root: string, mode: '--check' | '--write') {
  return spawnSync(
    process.execPath,
    [join(root, 'scripts/generate-catch-ratchet.mjs'), mode],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  );
}

describe('catch-ratchet generator', () => {
  it('blocks growth instead of blessing a newly introduced swallow', () => {
    const source = `export function probe() { try { operation(); } ${catchClause('')} }\n`;
    const root = makeFixture(source, '[]\n');
    const result = runGenerator(root, '--write');

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/growth|new catch/i);
    expect(readFileSync(
      join(root, 'eslint-rules/catch-ratchet-baseline.json'),
      'utf8',
    )).toBe('[]\n');
  });

  it('reports stale debt in check mode instead of silently rewriting it', () => {
    const staleIdentity = `src/probe.ts::${'a'.repeat(64)}`;
    const root = makeFixture('export const clean = true;\n', `${JSON.stringify([staleIdentity])}\n`);
    const result = runGenerator(root, '--check');

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/stale|shrank/i);
  });

  it('fails closed on malformed baseline JSON', () => {
    const root = makeFixture('export const clean = true;\n', '{not json\n');
    const result = runGenerator(root, '--check');

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/malformed|invalid json/i);
  });

  it('is inconclusive when the source scan examines zero files', () => {
    const root = makeFixture('', '[]\n');
    rmSync(join(root, 'src/probe.ts'));
    const result = runGenerator(root, '--check');

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /zero source files|no files (?:matching|found)/i,
    );
  });

  it.each([
    [
      'file-level suppression',
      '/* eslint-disable fitness/require-catch-justification -- suppression-resistance regression fixture; expires 2026-12-31 */\n'
        + `export function probe() { try { operation(); } ${catchClause('')} }\n`,
    ],
    [
      'next-line suppression',
      'export function probe() {\n'
        + '  try { operation(); }\n'
        + '  // eslint-disable-next-line fitness/require-catch-justification -- suppression-resistance regression fixture; expires 2026-12-31\n'
        + `  ${catchClause('')}\n`
        + '}\n',
    ],
  ])('blocks growth hidden by %s', (_label, source) => {
    const root = makeFixture(source, '[]\n');
    const result = runGenerator(root, '--check');

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/growth|new catch/i);
  });
});
