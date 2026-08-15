import { ESLint } from 'eslint';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- local ESLint plugin is a .mjs module with no type declarations; expires 2026-12-31
import fitnessPlugin from '../../eslint-rules/index.mjs';
// @ts-expect-error -- local ESLint rule is a .mjs module with no type declarations; expires 2026-12-31
import { hasMeaningfulEnvJustification, parseEnvAllowlist } from '../../eslint-rules/require-env-justification.mjs';
import tseslint from 'typescript-eslint';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYNTH_PATH = 'src/__env_probe__.ts';
const tmp = trackTmpDirs('');

const GOOD_REASON = 'bounded explicit-key env lookup, keys enumerated in-code';

function allowlistFile(rows: unknown): string {
  const dir = tmp.make('env-allowlist-rule');
  const path = join(dir, 'allowlist.json');
  writeFileSync(path, `${JSON.stringify({ rows })}\n`);
  return path;
}

// A default allowlist that does NOT cover the synthetic probe file, so every
// unmarked site reports unless a test provides its own rows.
function emptyAllowlist(): string {
  return allowlistFile([
    { file: 'src/__unrelated__.ts', allowedUnmarkedSites: 1, reason: 'placeholder row so rows[] is non-empty' },
  ]);
}

async function lint(code: string, baselinePath = emptyAllowlist()) {
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
        'fitness/require-env-justification': ['error', { baselinePath }],
      },
    },
  });
  return eslint.lintText(code, { filePath: SYNTH_PATH });
}

function ruleFindings(results: Awaited<ReturnType<typeof lint>>) {
  return results.flatMap((result) =>
    result.messages.filter((m) => m.ruleId === 'fitness/require-env-justification'),
  );
}

describe('fitness/require-env-justification — detection grain', () => {
  it('flags dot access, computed access, writes, deletes, and whole-object refs', async () => {
    const code = [
      "const a = process.env.FOO;",
      "const b = process.env['BAR'];",
      "process.env.BAZ = 'x';",
      "delete process.env['QUX'];",
      'export function probe(env = process.env) { return env; }',
    ].join('\n');
    const findings = ruleFindings(await lint(code));
    expect(findings).toHaveLength(5);
  });

  it('dedupes two process.env tokens on one line to ONE finding (the vitest line grain)', async () => {
    const code = "const pair = { a: process.env.FOO, b: process.env['BAR'] };\n";
    const findings = ruleFindings(await lint(code));
    expect(findings).toHaveLength(1);
  });

  it('reports nothing for env-free code', async () => {
    const findings = ruleFindings(await lint('export const x = 1;\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('fitness/require-env-justification — env-allowed markers', () => {
  it('accepts a same-line trailing marker meeting the quality floor', async () => {
    const code = `const a = process.env.FOO; // env-allowed: ${GOOD_REASON}\n`;
    expect(ruleFindings(await lint(code))).toHaveLength(0);
  });

  it('accepts a line-above marker meeting the quality floor', async () => {
    const code = `// env-allowed: ${GOOD_REASON}\nconst a = process.env.FOO;\n`;
    expect(ruleFindings(await lint(code))).toHaveLength(0);
  });

  it('rejects a marker below the quality floor (short / few words)', async () => {
    const code = 'const a = process.env.FOO; // env-allowed: tmp\n';
    expect(ruleFindings(await lint(code))).toHaveLength(1);
  });

  it('a marker two lines above does NOT justify the read', async () => {
    const code = `// env-allowed: ${GOOD_REASON}\n\nconst a = process.env.FOO;\n`;
    expect(ruleFindings(await lint(code))).toHaveLength(1);
  });
});

describe('fitness/require-env-justification — allowlist-count silence', () => {
  it('stays silent while unmarked sites are within the allowlist pin (5a transition window)', async () => {
    const rows = [{ file: SYNTH_PATH, allowedUnmarkedSites: 2, reason: 'transition-window pin for the probe file' }];
    const code = 'const a = process.env.FOO;\nconst b = process.env.BAR;\n';
    expect(ruleFindings(await lint(code, allowlistFile(rows)))).toHaveLength(0);
  });

  it('reports every unmarked site once the pin is exceeded', async () => {
    const rows = [{ file: SYNTH_PATH, allowedUnmarkedSites: 1, reason: 'transition-window pin for the probe file' }];
    const code = 'const a = process.env.FOO;\nconst b = process.env.BAR;\n';
    expect(ruleFindings(await lint(code, allowlistFile(rows)))).toHaveLength(2);
  });

  it('marked sites do not consume the unmarked allowance', async () => {
    const rows = [{ file: SYNTH_PATH, allowedUnmarkedSites: 1, reason: 'transition-window pin for the probe file' }];
    const code = `const a = process.env.FOO; // env-allowed: ${GOOD_REASON}\nconst b = process.env.BAR;\n`;
    expect(ruleFindings(await lint(code, allowlistFile(rows)))).toHaveLength(0);
  });
});

describe('fitness/require-env-justification — fail-closed SSOT', () => {
  it('a corrupt allowlist is a hard rule-load error, never a silent pass', async () => {
    const dir = tmp.make('env-allowlist-corrupt');
    const path = join(dir, 'allowlist.json');
    writeFileSync(path, '{not json');
    // The throw happens at rule creation and ESLint propagates it — linting
    // cannot proceed at all with a corrupt SSOT (stronger than a finding).
    await expect(lint('const a = process.env.FOO;\n', path)).rejects.toThrow(/invalid JSON/);
  });

  it('parseEnvAllowlist rejects empty rows and malformed entries', () => {
    expect(() => parseEnvAllowlist(JSON.stringify({ rows: [] }))).toThrow(/non-empty rows/);
    expect(() => parseEnvAllowlist(JSON.stringify({ rows: [{ file: 'x.ts', allowedUnmarkedSites: 0, reason: 'r' }] }))).toThrow(/malformed/);
    expect(() => parseEnvAllowlist(JSON.stringify({ rows: [{ file: 'x.ts', allowedUnmarkedSites: 2, reason: '' }] }))).toThrow(/malformed/);
  });

  it('hasMeaningfulEnvJustification enforces the 16-char/3-word floor', () => {
    expect(hasMeaningfulEnvJustification(`env-allowed: ${GOOD_REASON}`)).toBe(true);
    expect(hasMeaningfulEnvJustification('env-allowed: tmp')).toBe(false);
    expect(hasMeaningfulEnvJustification('env-allowed: two words-here')).toBe(false);
    expect(hasMeaningfulEnvJustification('unrelated comment text with many words here')).toBe(false);
  });
});
