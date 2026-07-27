import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK_PATH = resolve(new URL('.', import.meta.url).pathname, '../../.husky/pre-commit');

describe('pre-commit hook', () => {
  it('runs the estate scan unconditionally as a warn-only early signal', () => {
    const source = readFileSync(HOOK_PATH, 'utf8');
    const estateCommand = 'npm run guard:git-estate -- guard --phase pre-commit';

    expect(source).toContain(`if ! ${estateCommand}`);
    expect(source).toContain('git estate scan was inconclusive (warn-only)');
    expect(source.split(estateCommand)).toHaveLength(2);
    expect(source.indexOf(estateCommand)).toBeLessThan(
      source.indexOf('npm run guard:repo:staged'),
    );
  });

  it('checks console lint dependencies before running lint-staged', () => {
    const source = readFileSync(HOOK_PATH, 'utf8');

    expect(source).toContain('git diff --cached --name-only -- console/src');
    expect(source).toContain('console/node_modules/.bin/lint-staged');
    expect(source).toContain('console/node_modules/.bin/eslint');
    expect(source).toContain('cd console && npm ci');
    expect(source).not.toContain('npx lint-staged');
  });

  it('runs the design-system documentation hygiene guard before lint-staged', () => {
    const source = readFileSync(HOOK_PATH, 'utf8');

    expect(source).toContain('npm run guard:design-system-hygiene');
    expect(source.indexOf('npm run guard:design-system-hygiene')).toBeLessThan(
      source.indexOf('console/node_modules/.bin/lint-staged'),
    );
  });
});
