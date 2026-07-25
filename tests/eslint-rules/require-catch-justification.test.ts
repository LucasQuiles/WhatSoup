import { ESLint } from 'eslint';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- local ESLint plugin is a .mjs module with no type declarations; expires 2026-12-31
import fitnessPlugin from '../../eslint-rules/index.mjs';
import tseslint from 'typescript-eslint';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_BASELINE = resolve(
  REPO_ROOT,
  'eslint-rules/catch-ratchet-baseline.json',
);
const SYNTH_PATH = 'src/__catch_probe__.ts';
const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function baselineFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'catch-ratchet-rule-'));
  tempRoots.push(dir);
  const path = join(dir, 'baseline.json');
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

function catchClause(param: string, body: string): string {
  return ['catch', param, ' {', body, '}'].join('');
}

function sourceWith(clause: string, leading = ''): string {
  return `${leading}export function probe() {\n  try { operation(); } ${clause}\n}\n`;
}

async function lint(
  code: string,
  baselinePath = baselineFile([]),
  mode: 'enforce' | 'report-all' = 'enforce',
): Promise<ReturnType<ESLint['lintText']> extends Promise<infer T> ? T : never> {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['src/**/*.ts'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
      },
      plugins: { fitness: fitnessPlugin },
      rules: {
        'fitness/require-catch-justification': ['error', { baselinePath, mode }],
      },
    },
  });
  return eslint.lintText(code, { filePath: SYNTH_PATH });
}

async function lintWithFitnessConfig(code: string) {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: resolve(REPO_ROOT, 'eslint.config.fitness.mjs'),
  });
  return eslint.lintText(code, { filePath: SYNTH_PATH });
}

function ruleMessages(results: Awaited<ReturnType<typeof lint>>) {
  return results.flatMap((result) =>
    result.messages.filter(
      (message) => message.ruleId === 'fitness/require-catch-justification',
    ),
  );
}

function reportedIdentity(message: ReturnType<typeof ruleMessages>[number]): string {
  const match = /\[catch-ratchet:(.+)]$/.exec(message.message);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe('fitness/require-catch-justification', () => {
  it('flags an empty unbound catch', async () => {
    const messages = ruleMessages(await lint(sourceWith(catchClause('', ''))));
    expect(messages.map((message) => message.messageId)).toEqual(['unjustifiedCatch']);
  });

  it('does not let an unused catch binding hide an empty swallow', async () => {
    const messages = ruleMessages(
      await lint(sourceWith(catchClause(' (ignored)', ''))),
    );
    expect(messages.map((message) => message.messageId)).toEqual(['unjustifiedCatch']);
  });

  it.each([
    ['empty statements', ';'],
    ['bare noop identifiers', ' noop; intentional;'],
    ['void expressions', ' void ignored;'],
    ['obvious noop calls', ' noop();'],
    ['literal expression statements', " 'intentional';"],
    ['inert declarations', ' const observed = ignored;'],
    ['inert logical expressions', ' ignored && "still ignored";'],
    ['empty nested blocks', ' { ; }'],
    ['inert function expressions', ' (() => ignored);'],
  ])('flags %s as trivial handling', async (_label, body) => {
    const messages = ruleMessages(
      await lint(sourceWith(catchClause(' (ignored)', body))),
    );
    expect(messages.map((message) => message.messageId)).toEqual(['unjustifiedCatch']);
  });

  it.each([
    [
      'file-level suppression',
      '/* eslint-disable fitness/require-catch-justification -- suppression-resistance regression fixture; expires 2026-12-31 */\n',
      catchClause('', ''),
    ],
    [
      'next-line suppression',
      '',
      '// eslint-disable-next-line fitness/require-catch-justification -- suppression-resistance regression fixture; expires 2026-12-31\n  catch {}',
    ],
  ])('does not let %s hide catch debt in the fitness config', async (
    _label,
    leading,
    clause,
  ) => {
    const code = clause.startsWith('//')
      ? `${leading}export function probe() {\n  try { operation(); }\n  ${clause}\n}\n`
      : sourceWith(clause, leading);
    const messages = ruleMessages(await lintWithFitnessConfig(code));
    expect(messages.map((message) => message.messageId)).toEqual(['unjustifiedCatch']);
  });

  it.each([
    '/* intentional */',
    '/* noop */',
    '/* by design */',
    '/* intentional: because */',
  ])('rejects a magic-word-only comment: %s', async (comment) => {
    const messages = ruleMessages(
      await lint(sourceWith(catchClause('', ` ${comment} `))),
    );
    expect(messages.map((message) => message.messageId)).toEqual(['unjustifiedCatch']);
  });

  it('accepts a reasoned justification for an otherwise trivial swallow', async () => {
    const comment =
      '/* intentional: optional cleanup failures must not replace the primary result */';
    const messages = ruleMessages(
      await lint(sourceWith(catchClause('', ` ${comment} `))),
    );
    expect(messages).toEqual([]);
  });

  it('accepts observable handling without demanding a comment', async () => {
    const messages = ruleMessages(
      await lint(
        sourceWith(
          catchClause(' (error)', ' logger.warn({ error }, "cleanup failed");'),
        ),
      ),
    );
    expect(messages).toEqual([]);
  });

  it('fails closed when the baseline is malformed', async () => {
    await expect(
      lint(sourceWith(catchClause('', '')), baselineFile({ old: true })),
    ).rejects.toThrow(/baseline.*array/i);
  });

  it('keeps the same baseline identity after unrelated line movement', async () => {
    const clause = catchClause('', '');
    const initial = ruleMessages(
      await lint(sourceWith(clause), baselineFile([]), 'report-all'),
    );
    const identity = reportedIdentity(initial[0]!);
    const shifted = ruleMessages(
      await lint(sourceWith(clause, '\n\n// unrelated documentation\n'), baselineFile([identity])),
    );

    expect(shifted).toEqual([]);
  });

  it('uses duplicate baseline entries as a budget, not a blanket exemption', async () => {
    const clause = catchClause('', '');
    const single = ruleMessages(
      await lint(sourceWith(clause), baselineFile([]), 'report-all'),
    );
    const identity = reportedIdentity(single[0]!);
    const duplicateSource = [
      sourceWith(clause),
      'export function secondProbe() {',
      `  try { operation(); } ${clause}`,
      '}',
      '',
    ].join('\n');
    const messages = ruleMessages(
      await lint(duplicateSource, baselineFile([identity])),
    );

    expect(messages.map((message) => message.messageId)).toEqual(['unjustifiedCatch']);
  });

  it('reports no unbaselined catch debt across the real src tree', async () => {
    const eslint = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['src/**/*.ts'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
        },
        plugins: { fitness: fitnessPlugin },
        rules: {
          'fitness/require-catch-justification': [
            'error',
            { baselinePath: REAL_BASELINE },
          ],
        },
      },
    });
    const messages = ruleMessages(await eslint.lintFiles(['src/']));
    expect(messages).toEqual([]);
  }, 180_000);
});
