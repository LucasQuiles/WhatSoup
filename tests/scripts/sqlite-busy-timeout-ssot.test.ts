// Arch ratchet: executable SQLite busy-timeout configuration must be
// concentrated in src/lib/sqlite-constants.ts. Every other active TypeScript
// source under src/ or scripts/ must use SQLITE_BUSY_TIMEOUT_PRAGMA or
// SQLITE_BUSY_TIMEOUT_MS. The same AST rule provides author-time ESLint
// feedback and this blocking zero-finding check. It follows same-module const
// chains into direct member calls named exec/prepare and resolves inline or
// same-module DatabaseSync option objects plus ordered spreads. Recognized
// mutations through the binding or const aliases and ambiguous constructor
// argument spreads fail closed. Inert documentation strings do not count.
// Interprocedural SQL construction, helper-hidden mutation, and aliased sink
// methods remain documented review boundaries in
// docs/architecture/fitness-taxonomy.md.
//
// Baseline was four raw PRAGMA sites (db-reader.ts, group-resolver.ts,
// database.ts, close-recovery-catchup.ts) plus three DatabaseSync option sites.
import { ESLint } from 'eslint';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from 'vitest';

// @ts-expect-error -- flat config is a .mjs module with no type declarations; expires 2026-12-31
import { enabledFitnessRuleNames } from '../../eslint.config.fitness.mjs';

const RULE_ID = 'fitness/no-magic-sqlite-pragma';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const loadBearingFalsifiers = [
  {
    name: 'constructor second-argument spread',
    code: `
      import { DatabaseSync } from 'node:sqlite';
      new DatabaseSync(path, ...args);
    `,
    messageId: 'unknownOptions',
  },
  {
    name: 'constructor all-argument spread',
    code: `
      import { DatabaseSync } from 'node:sqlite';
      new DatabaseSync(...args);
    `,
    messageId: 'unknownOptions',
  },
  {
    name: 'const options member mutation',
    code: `
      import { DatabaseSync } from 'node:sqlite';
      import { SQLITE_BUSY_TIMEOUT_MS } from './lib/sqlite-constants.ts';
      const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS };
      OPTIONS.timeout = 5000;
      new DatabaseSync(path, OPTIONS);
    `,
    messageId: 'unknownOptions',
  },
  {
    name: 'const options update mutation',
    code: `
      import { DatabaseSync } from 'node:sqlite';
      import { SQLITE_BUSY_TIMEOUT_MS } from './lib/sqlite-constants.ts';
      const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS };
      OPTIONS.timeout++;
      new DatabaseSync(path, OPTIONS);
    `,
    messageId: 'unknownOptions',
  },
  {
    name: 'const options delete mutation',
    code: `
      import { DatabaseSync } from 'node:sqlite';
      import { SQLITE_BUSY_TIMEOUT_MS } from './lib/sqlite-constants.ts';
      const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS };
      delete OPTIONS.timeout;
      new DatabaseSync(path, OPTIONS);
    `,
    messageId: 'unknownOptions',
  },
  {
    name: 'Object.assign options mutation',
    code: `
      import { DatabaseSync } from 'node:sqlite';
      import { SQLITE_BUSY_TIMEOUT_MS } from './lib/sqlite-constants.ts';
      const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS };
      Object.assign(OPTIONS, { timeout: 5000 });
      new DatabaseSync(path, OPTIONS);
    `,
    messageId: 'unknownOptions',
  },
  {
    name: 'defineProperty alias mutation',
    code: `
      import { DatabaseSync } from 'node:sqlite';
      import { SQLITE_BUSY_TIMEOUT_MS } from './lib/sqlite-constants.ts';
      const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS };
      const ALIAS = OPTIONS;
      Object.defineProperty(ALIAS, 'timeout', { value: 5000 });
      new DatabaseSync(path, OPTIONS);
    `,
    messageId: 'unknownOptions',
  },
  {
    name: 'unary-plus numeric PRAGMA',
    code: "raw.exec('PRAGMA busy_timeout = +5000');",
    messageId: 'useConstant',
  },
  {
    name: 'comment-separated numeric PRAGMA',
    code: "raw.exec('PRAGMA /* guard comment */ busy_timeout = 5000');",
    messageId: 'useConstant',
  },
  {
    name: 'exponent numeric PRAGMA',
    code: "raw.exec('PRAGMA busy_timeout = 5e3');",
    messageId: 'useConstant',
  },
  {
    name: 'hexadecimal numeric PRAGMA',
    code: "raw.exec('PRAGMA busy_timeout = 0x1388');",
    messageId: 'useConstant',
  },
  {
    name: 'single-quoted numeric PRAGMA',
    code: `raw.exec("PRAGMA busy_timeout = '5000'");`,
    messageId: 'useConstant',
  },
  {
    name: 'double-quoted numeric PRAGMA',
    code: `raw.exec('PRAGMA busy_timeout = "5000"');`,
    messageId: 'useConstant',
  },
  {
    name: 'backtick-quoted numeric PRAGMA',
    code: "raw.exec('PRAGMA busy_timeout = `5000`');",
    messageId: 'useConstant',
  },
  {
    name: 'bracket-quoted numeric PRAGMA',
    code: "raw.exec('PRAGMA busy_timeout = [5000]');",
    messageId: 'useConstant',
  },
  {
    name: 'comment-separated quoted numeric PRAGMA',
    code: `raw.exec("PRAGMA busy_timeout = /* gap */ '+5000'");`,
    messageId: 'useConstant',
  },
  {
    name: 'parenthesized quoted exponent PRAGMA',
    code: `raw.exec("PRAGMA busy_timeout('5e3')");`,
    messageId: 'useConstant',
  },
  {
    name: 'quoted numeric-prefix PRAGMA',
    code: `raw.exec("PRAGMA busy_timeout = '5''000'");`,
    messageId: 'useConstant',
  },
  {
    name: 'multi-statement quoted numeric PRAGMA',
    code: `raw.exec("SELECT 1; PRAGMA busy_timeout = '5000'");`,
    messageId: 'useConstant',
  },
  {
    name: 'schema-qualified quoted numeric PRAGMA',
    code: `raw.exec("PRAGMA main.busy_timeout = '5000'");`,
    messageId: 'useConstant',
  },
  {
    name: 'quoted-name numeric PRAGMA',
    code: `raw.exec("PRAGMA \\"busy_timeout\\" = '5000'");`,
    messageId: 'useConstant',
  },
] as const;

test('SQLite busy-timeout configuration is single-sourced across active TypeScript sources', async () => {
  expect(enabledFitnessRuleNames).toContain(RULE_ID);

  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: resolve(repoRoot, 'eslint.config.fitness.mjs'),
    errorOnUnmatchedPattern: true,
  });
  const results = await eslint.lintFiles(['src/**/*.ts', 'scripts/**/*.ts']);
  expect(results.length).toBeGreaterThan(100);

  const scannerFailures = results.flatMap((result) => result.messages
    .filter((message) => message.fatal || message.severity === 2)
    .map((message) => `${result.filePath}:${message.line} ${message.message}`));
  expect(scannerFailures).toEqual([]);

  const findings = results.flatMap((result) => result.messages
    .filter((message) => message.ruleId === RULE_ID)
    .map((message) => `${result.filePath}:${message.line}`));
  expect(findings).toEqual([]);
}, 180_000);

test.each(loadBearingFalsifiers)(
  'configured ratchet detects $name',
  async ({ code, messageId }) => {
    const eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: resolve(repoRoot, 'eslint.config.fitness.mjs'),
    });
    const [result] = await eslint.lintText(code, {
      filePath: resolve(repoRoot, 'src/ratchet-falsifier.ts'),
    });
    const findings = result.messages
      .filter((message) => message.ruleId === RULE_ID)
      .map((message) => message.messageId);
    expect(findings).toEqual([messageId]);
  },
);
