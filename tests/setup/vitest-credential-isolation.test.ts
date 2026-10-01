import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const root = process.cwd();
const tmp = trackTmpDirs('credential-isolation-');

describe('Vitest credential isolation', () => {
  // @skip-env The shims and decoys are POSIX sh scripts, which Windows cannot run.
  it.skipIf(process.platform === 'win32')(
    'shadows inherited stores while preserving resolver fallback on both platforms',
    () => {
      const dir = tmp.make('fixture');
      const bin = join(dir, 'upstream-bin');
      mkdirSync(bin, { mode: 0o700 });
      const attempted = join(dir, 'attempted');
      const results = join(dir, 'results.json');
      // A controlled command replaces the ambient store even in the failing baseline:
      // the nested run puts this directory first on PATH before any keyring import.
      const decoy = '#!/bin/sh\nprintf x >> "$WHATSOUP_CREDENTIAL_DECOY_LOG"\nprintf ambient-store-fixture\n';
      for (const command of ['security', 'secret-tool']) {
        writeFileSync(join(bin, command), decoy, { mode: 0o700 });
      }
      const config = join(dir, 'vitest.config.mts');
      writeFileSync(config, `export default ${JSON.stringify({
        root: dir,
        cacheDir: join(dir, '.vite'),
        test: {
          include: ['probe.test.mjs'],
          setupFiles: [resolve(root, 'tests/setup/bot-errors-vitest-isolation.ts')],
          maxWorkers: 1,
          fileParallelism: false,
        },
      })};`);
      writeFileSync(join(dir, 'probe.test.mjs'), [
        `import { it, expect, afterAll } from ${JSON.stringify(resolve(root, 'node_modules/vitest/dist/index.js'))};`,
        `import { detectKeyringBackend, lookupCredential, _resetBackendCache } from ${JSON.stringify(resolve(root, 'src/lib/keyring.ts'))};`,
        `import { resolveApiKey } from ${JSON.stringify(resolve(root, 'src/lib/api-key-resolver.ts'))};`,
        "import { writeFileSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        'const rows = [];',
        'const originalPlatform = process.platform;',
        "afterAll(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); writeFileSync(process.env.WHATSOUP_CREDENTIAL_PROBE_RESULTS, JSON.stringify(rows)); });",
        "it.each(['darwin', 'linux'])('isolates %s', platform => {",
        "Object.defineProperty(process, 'platform', { value: platform }); _resetBackendCache();",
        "process.env.OPENAI_API_KEY = 'explicit-environment-fixture';",
        // The outer run exports REQUIRE_OS_KEYRING; the shared setup must clear it.
        'const requireOsKeyring = process.env.REQUIRE_OS_KEYRING ?? null;',
        'const backend = detectKeyringBackend();',
        "const credential = lookupCredential('openai', { skipEnv: true, skipMigrationFallbacks: true });",
        "const fallback = resolveApiKey({ envVar: 'OPENAI_API_KEY' });",
        'rows.push({ platform, backend, requireOsKeyring, credential, fallback });',
        "expect({ credential, fallback }).toEqual({ credential: null, fallback: 'explicit-environment-fixture' });",
        "const command = platform === 'darwin' ? 'security' : 'secret-tool';",
        "const operation = platform === 'darwin' ? 'find-generic-password' : 'lookup';",
        `const inherited = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:child_process").execFileSync(process.argv[1], process.argv.slice(2)))', command, operation], { encoding: 'utf8', timeout: 2000 });`,
        'expect(inherited.error, inherited.stderr).toBeUndefined();',
        'expect({ status: inherited.status, output: inherited.stdout }).toEqual({ status: 0, output: \'\' });',
        "for (const mutation of platform === 'darwin' ? ['add-generic-password', 'delete-generic-password', 'synthetic-unsupported-operation'] : ['store', 'clear', 'synthetic-unsupported-operation']) {",
        "const rejected = spawnSync(command, [mutation], { input: 'synthetic-write-fixture'.repeat(12000) /* 276,000 bytes, more than a pipe buffer: a shim that exits without draining stdin fails with EPIPE */, encoding: 'utf8', timeout: 2000 });",
        'expect(rejected.error, `${mutation}: ${rejected.stderr}`).toBeUndefined();',
        'expect({ mutation, status: rejected.status }).toEqual({ mutation, status: 1 });',
        "expect(rejected.stderr).toContain('synthetic credential backend rejects writes');",
        '}',
        '});',
      ].join('\n'));
      const child = spawnSync(process.execPath, [
        resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--pool=forks',
      ], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
          WHATSOUP_CREDENTIAL_DECOY_LOG: attempted,
          WHATSOUP_CREDENTIAL_PROBE_RESULTS: results,
          REQUIRE_OS_KEYRING: '1',
        },
        encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
      });

      const output = child.stdout + child.stderr;
      expect(child.error, child.stderr).toBeUndefined();
      // Rows before status: an import or collection failure in the nested run
      // writes no rows, so it cannot pass for an assertion failure.
      expect(existsSync(results), `the nested probe did not run:\n${output}`).toBe(true);
      expect(JSON.parse(readFileSync(results, 'utf8')), output).toEqual([
        {
          platform: 'darwin', backend: 'macos-keychain', requireOsKeyring: null,
          credential: null, fallback: 'explicit-environment-fixture',
        },
        {
          platform: 'linux', backend: 'env-only', requireOsKeyring: null,
          credential: null, fallback: 'explicit-environment-fixture',
        },
      ]);
      expect(child.status, output).toBe(0);
      expect(existsSync(attempted), 'the ambient credential-store decoy was executed').toBe(false);
    },
    90_000,
  );
});
