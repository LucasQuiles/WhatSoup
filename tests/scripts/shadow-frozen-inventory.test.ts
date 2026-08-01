import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-shadow-frozen-inventory.mjs');

const tmp = trackTmpDirs('');

interface EslintHit {
  file: string;
  line: number;
  column?: number;
  message: string;
  ruleId?: string;
}

function makeFixture(hits: EslintHit[]) {
  const root = tmp.make('shadow-frozen-inventory');

  const byFile = new Map<string, Array<{ column: number; line: number; message: string; ruleId: string }>>();
  for (const hit of hits) {
    const messages = byFile.get(hit.file) ?? [];
    messages.push({
      column: hit.column ?? 1,
      line: hit.line,
      message: hit.message,
      ruleId: hit.ruleId ?? 'no-restricted-syntax',
    });
    byFile.set(hit.file, messages);
  }

  const eslintJson = join(root, 'eslint.json');
  writeFileSync(
    eslintJson,
    JSON.stringify(
      [...byFile.entries()].map(([filePath, messages]) => ({
        filePath: join(root, filePath),
        messages,
      })),
      null,
      2,
    ),
  );

  return { eslintJson, root };
}

function run(extraArgs: string[] = []) {
  return spawnSync('node', [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function parsedOutput(result: ReturnType<typeof run>) {
  return JSON.parse(result.stdout) as {
    baseline?: {
      errors: Array<{ code: string }>;
      mismatches: Array<{ path: string; message: string }>;
      update: boolean;
    };
    hits: Array<{
      category: string;
      file: string;
      line: number;
      rule: string;
    }>;
    totals: {
      by_category: Record<string, number>;
      files: number;
      total: number;
    };
    verdict: 'PASS' | 'FAIL';
  };
}

const baseWall = {
  file: 'console/src/components/Foo.tsx',
  line: 4,
  message: '⛔ Inline transition with hardcoded duration. FIX: use var(--dur-fast).',
};

const brandRegression = {
  file: 'console/src/components/Nav.tsx',
  line: 8,
  message: '[soup/no-brand-regression] "WhatSoup" in JSX text — replace with the locked brand name.',
  ruleId: 'soup/no-brand-regression',
};

describe('check-shadow-frozen-inventory.mjs', () => {
  it('captures only frozen shadow categories with exact file and line shape', () => {
    const { eslintJson, root } = makeFixture([
      baseWall,
      brandRegression,
      {
        file: 'console/src/components/Config.tsx',
        line: 12,
        message: '[soup/no-raw-form-control SHADOW] Raw form control element.',
      },
    ]);

    const result = run(['--root', root, '--eslint-json', eslintJson, '--no-baseline']);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.totals).toEqual({
      by_category: {
        'base-wall': 1,
        'brand-regression': 1,
      },
      files: 2,
      total: 2,
    });
    expect(output.hits.map((hit) => `${hit.category}:${hit.file}:${hit.line}`)).toEqual([
      'base-wall:console/src/components/Foo.tsx:4',
      'brand-regression:console/src/components/Nav.tsx:8',
    ]);
  });

  it('writes and compares a generated baseline, then fails on same-count line drift', () => {
    const { eslintJson, root } = makeFixture([baseWall, brandRegression]);
    const baseline = join(root, 'console', 'design-shadow-frozen-inventory.json');
    mkdirSync(dirname(baseline), { recursive: true });

    const update = run(['--root', root, '--eslint-json', eslintJson, '--baseline', baseline, '--update']);
    expect(update.status).toBe(0);

    const compare = run(['--root', root, '--eslint-json', eslintJson, '--baseline', baseline]);
    expect(compare.status).toBe(0);
    expect(parsedOutput(compare).baseline?.mismatches).toEqual([]);

    const drifted = makeFixture([
      { ...baseWall, line: 5 },
      brandRegression,
    ]);
    const drift = run(['--root', drifted.root, '--eslint-json', drifted.eslintJson, '--baseline', baseline]);
    const output = parsedOutput(drift);

    expect(drift.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.baseline?.mismatches).toEqual([
      expect.objectContaining({ path: 'generated_inventory' }),
    ]);
  });

  it('refuses injected ESLint JSON updates without an explicit fixture baseline path', () => {
    const { eslintJson, root } = makeFixture([baseWall]);
    const result = run(['--root', root, '--eslint-json', eslintJson, '--update']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cannot be combined with --update without --baseline');
  });
});
