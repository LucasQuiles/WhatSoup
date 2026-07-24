import { RuleTester } from '@typescript-eslint/rule-tester';
import { resolve } from 'node:path';
import { afterAll, describe, it } from 'vitest';

// @ts-expect-error -- local ESLint plugin is a .mjs module with no type declarations; expires 2026-12-31
import fitnessPlugin from '../../eslint-rules/index.mjs';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();
const rule = fitnessPlugin.rules['no-magic-sqlite-pragma'];

ruleTester.run('no-magic-sqlite-pragma', rule, {
  valid: [
    {
      filename: resolve(process.cwd(), 'src/fleet/group-resolver.ts'),
      code: `
        import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../lib/sqlite-constants.ts';
        raw.exec(SQLITE_BUSY_TIMEOUT_PRAGMA);
      `,
    },
    {
      filename: resolve(process.cwd(), 'scripts/close-recovery-catchup.ts'),
      code: `
        import { SQLITE_BUSY_TIMEOUT_MS } from '../src/lib/sqlite-constants.ts';
        raw.exec(\`PRAGMA busy_timeout = \${SQLITE_BUSY_TIMEOUT_MS}\`);
      `,
    },
    {
      filename: resolve(process.cwd(), 'src/lib/sqlite-constants.ts'),
      code: "export const SQLITE_BUSY_TIMEOUT_PRAGMA = 'PRAGMA busy_timeout = 5000';",
    },
    {
      filename: '/repo/src/core/database.ts',
      code: "raw.exec('PRAGMA foreign_keys = ON');",
    },
    {
      filename: resolve(process.cwd(), 'src/core/database.ts'),
      code: `
        import { DatabaseSync } from 'node:sqlite';
        import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/sqlite-constants.ts';
        new DatabaseSync(path, { timeout: SQLITE_BUSY_TIMEOUT_MS });
      `,
    },
    {
      filename: '/repo/src/fleet/db-reader.ts',
      code: `
        import { DatabaseSync } from 'node:sqlite';
        const READ_ONLY_DATABASE_OPTIONS:
          ConstructorParameters<typeof DatabaseSync>[1] = { readOnly: true };
        new DatabaseSync(path, READ_ONLY_DATABASE_OPTIONS);
      `,
    },
    {
      filename: resolve(process.cwd(), 'src/core/database.ts'),
      code: `
        import { DatabaseSync } from 'node:sqlite';
        import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/sqlite-constants.ts';
        const READ_ONLY_DATABASE_OPTIONS = { readOnly: true };
        new DatabaseSync(path, {
          ...READ_ONLY_DATABASE_OPTIONS,
          timeout: SQLITE_BUSY_TIMEOUT_MS,
        });
      `,
    },
    {
      filename: resolve(process.cwd(), 'src/core/database.ts'),
      code: `
        import { DatabaseSync } from 'node:sqlite';
        import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/sqlite-constants.ts';
        const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS } satisfies object;
        new DatabaseSync(path, OPTIONS);
      `,
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        class DatabaseSync {}
        new DatabaseSync(path, { timeout: 5000 });
      `,
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        const local = { DatabaseSync: class {} };
        new local.DatabaseSync(path, { timeout: 5000 });
      `,
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec("SELECT 'PRAGMA busy_timeout = 5000' AS example");`,
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec("SELECT '; PRAGMA busy_timeout = 5000' AS example");`,
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec('Troubleshooting prose: PRAGMA busy_timeout = 5000');`,
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        // PRAGMA busy_timeout = 5000 is documentation, not executable SQL.
        /* pragma busy_timeout(2345) is also documentation. */
        const troubleshootingExample = 'PRAGMA busy_timeout = 5000';
        renderDocumentation(troubleshootingExample);
      `,
    },
  ],
  invalid: [
    {
      filename: '/repo/src/core/database.ts',
      code: "raw.exec('PRAGMA busy_timeout = 5000');",
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/scripts/close-recovery-catchup.ts',
      code: 'raw.exec(`pragma  busy_timeout=10000`);',
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/scripts/close-recovery-catchup.ts',
      code: "raw.exec('PRAGMA busy_timeout(2345)');",
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: 'raw.exec(`PRAGMA busy_timeout = ${5000}`);',
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: "raw.exec('PRAGMA busy_timeout = ' + 5000);",
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: 'raw.exec(`PRAGMA busy_timeout = ${OTHER_TIMEOUT_MS}`);',
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: "raw.exec('PRAGMA busy_timeout = ' + OTHER_TIMEOUT_MS);",
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: resolve(
        process.cwd(),
        'nested-copy/src/lib/sqlite-constants.ts',
      ),
      code: `
        export const FORK = 'PRAGMA busy_timeout = 5000';
        raw.exec(FORK);
      `,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        import { DatabaseSync } from 'node:sqlite';
        new DatabaseSync(path, { timeout: 5000 });
      `,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database-compatibility-early.ts',
      code: `
        import { DatabaseSync } from 'node:sqlite';
        new DatabaseSync(path, { readOnly: true, timeout: 2_500 + 2_500 });
      `,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        import { DatabaseSync } from 'node:sqlite';
        const TIMEOUT = 5000;
        new DatabaseSync(path, { timeout: TIMEOUT });
      `,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        import { DatabaseSync } from 'node:sqlite';
        const OPTIONS = { readOnly: true, timeout: 5000 };
        new DatabaseSync(path, OPTIONS);
      `,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        import { DatabaseSync } from 'node:sqlite';
        const OPTIONS = { timeout: 2_500 + 2_500 };
        new DatabaseSync(path, { readOnly: true, ...OPTIONS });
      `,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        import { DatabaseSync } from 'node:sqlite';
        import { OPTIONS } from './database-options.ts';
        new DatabaseSync(path, OPTIONS);
      `,
      errors: [{ messageId: 'unknownOptions' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        import { DatabaseSync } from 'node:sqlite';
        import { OPTIONS } from './database-options.ts';
        new DatabaseSync(path, { readOnly: true, ...OPTIONS });
      `,
      errors: [{ messageId: 'unknownOptions' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        import { DatabaseSync } from 'node:sqlite';
        new DatabaseSync(path, ...args);
      `,
      errors: [{ messageId: 'unknownOptions' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        import { DatabaseSync } from 'node:sqlite';
        new DatabaseSync(...args);
      `,
      errors: [{ messageId: 'unknownOptions' }],
    },
    {
      filename: resolve(process.cwd(), 'src/core/database.ts'),
      code: `
        import { DatabaseSync } from 'node:sqlite';
        import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/sqlite-constants.ts';
        const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS };
        OPTIONS.timeout = 5000;
        new DatabaseSync(path, OPTIONS);
      `,
      errors: [{ messageId: 'unknownOptions' }],
    },
    {
      filename: resolve(process.cwd(), 'src/core/database.ts'),
      code: `
        import { DatabaseSync } from 'node:sqlite';
        import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/sqlite-constants.ts';
        const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS };
        OPTIONS.timeout++;
        new DatabaseSync(path, OPTIONS);
      `,
      errors: [{ messageId: 'unknownOptions' }],
    },
    {
      filename: resolve(process.cwd(), 'src/core/database.ts'),
      code: `
        import { DatabaseSync } from 'node:sqlite';
        import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/sqlite-constants.ts';
        const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS };
        delete OPTIONS.timeout;
        new DatabaseSync(path, OPTIONS);
      `,
      errors: [{ messageId: 'unknownOptions' }],
    },
    {
      filename: resolve(process.cwd(), 'src/core/database.ts'),
      code: `
        import { DatabaseSync } from 'node:sqlite';
        import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/sqlite-constants.ts';
        const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS };
        Object.assign(OPTIONS, { timeout: 5000 });
        new DatabaseSync(path, OPTIONS);
      `,
      errors: [{ messageId: 'unknownOptions' }],
    },
    {
      filename: resolve(process.cwd(), 'src/core/database.ts'),
      code: `
        import { DatabaseSync } from 'node:sqlite';
        import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/sqlite-constants.ts';
        const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS };
        Object.defineProperty(OPTIONS, 'timeout', { value: 5000 });
        new DatabaseSync(path, OPTIONS);
      `,
      errors: [{ messageId: 'unknownOptions' }],
    },
    {
      filename: resolve(process.cwd(), 'src/core/database.ts'),
      code: `
        import { DatabaseSync } from 'node:sqlite';
        import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/sqlite-constants.ts';
        const OPTIONS = { timeout: SQLITE_BUSY_TIMEOUT_MS };
        const ALIAS = OPTIONS;
        Object.defineProperties(ALIAS, {
          timeout: { value: 5000 },
        });
        new DatabaseSync(path, OPTIONS);
      `,
      errors: [{ messageId: 'unknownOptions' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        import { DatabaseSync as DB } from 'node:sqlite';
        new DB(path, { timeout: 5000 });
      `,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        import * as sqlite from 'node:sqlite';
        new sqlite.DatabaseSync(path, { timeout: 5000 });
      `,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: "raw.exec('PRAGMA busy_timeout = +5000');",
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: "raw.exec('PRAGMA /* guard comment */ busy_timeout = 5000');",
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: "raw.exec('PRAGMA busy_timeout = 5e3');",
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: "raw.exec('PRAGMA busy_timeout = 0x1388');",
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec("PRAGMA busy_timeout = '5000'");`,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec('PRAGMA busy_timeout = "5000"');`,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: "raw.exec('PRAGMA busy_timeout = `5000`');",
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: "raw.exec('PRAGMA busy_timeout = [5000]');",
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec("PRAGMA busy_timeout = /* gap */ '+5000'");`,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec("PRAGMA busy_timeout('5e3')");`,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec("PRAGMA busy_timeout = '0x1388'");`,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec("PRAGMA busy_timeout = '5''000'");`,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec("PRAGMA busy_timeout = '5/* preserved */000'");`,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec("SELECT 1; PRAGMA busy_timeout = '5000'");`,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec("PRAGMA main.busy_timeout = '5000'");`,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `raw.exec("PRAGMA \\"busy_timeout\\" = '5000'");`,
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: "runner.exec('PRAGMA busy_timeout = 5000');",
      errors: [{ messageId: 'useConstant' }],
    },
    {
      filename: '/repo/src/core/database.ts',
      code: `
        const BUSY_TIMEOUT = 5_000;
        const BUSY_TIMEOUT_PRAGMA = \`PRAGMA busy_timeout = \${BUSY_TIMEOUT}\`;
        raw.prepare(BUSY_TIMEOUT_PRAGMA).run();
      `,
      errors: [{ messageId: 'useConstant' }],
    },
  ],
});
