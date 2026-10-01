import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const root = process.cwd();
const tmp = trackTmpDirs('credential-isolation-');

// These timeouts are hang guards, not performance bounds. Each layer allows the
// worst case of the layer it wraps. A platform leg makes at most six guarded
// spawns (an inherited read, three rejected writes and two other rejections) and
// two keyring lookups, each under the keyring's own 3 s timeout; the nested run
// has two legs.
const SPAWN_GUARD_MS = 10_000;
const NESTED_TEST_TIMEOUT_MS = 6 * SPAWN_GUARD_MS + 10_000;
const NESTED_RUN_TIMEOUT_MS = 2 * NESTED_TEST_TIMEOUT_MS + 30_000;
const TEST_TIMEOUT_MS = NESTED_RUN_TIMEOUT_MS + 30_000;

const REJECTION = 'synthetic credential backend rejects writes and unsupported operations';
// The real macOS tool's message for a missing item, which it reports with exit 44.
const NOT_FOUND = 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.';
// The piped write sends a small input shaped like the macOS caller's: the value
// twice, each with a newline. Two release gates failed here when a rejection
// that carried a 131,100-byte piped input stalled for the whole spawn guard
// while its neighbours took milliseconds: writing that input needs many
// write-readiness wakeups on the 8 KiB macOS socket pair, and a small input is
// written in one call. The cause in Node or macOS is not established. A hang on
// this small-input spawn would refute that reading.
const WRITE_FIXTURE = 'synthetic-write-fixture\n'.repeat(2);
// Larger than a pipe or socket buffer on either platform. It reaches the shims
// as a regular file, so the parent writes nothing.
const STDIN_FILE_BYTES = 131_100;

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
      const stdinFile = join(dir, 'stdin-fixture');
      writeFileSync(stdinFile, 'x'.repeat(STDIN_FILE_BYTES));
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
          testTimeout: NESTED_TEST_TIMEOUT_MS,
        },
      })};`);
      writeFileSync(join(dir, 'probe.test.mjs'), [
        `import { it, expect, afterAll } from ${JSON.stringify(resolve(root, 'node_modules/vitest/dist/index.js'))};`,
        `import { detectKeyringBackend, lookupCredential, _resetBackendCache } from ${JSON.stringify(resolve(root, 'src/lib/keyring.ts'))};`,
        `import { resolveApiKey } from ${JSON.stringify(resolve(root, 'src/lib/api-key-resolver.ts'))};`,
        "import { closeSync, openSync, readSync, writeFileSync } from 'node:fs';",
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
        "const read = platform === 'darwin' ? 'find-generic-password' : 'lookup';",
        // The last stderr line is the message, terminated or not: a shell start-up
        // warning before it is outside the contract. Empty stderr is no message.
        "const message = result => { const text = result.stderr ?? ''; return text === '' ? undefined : text.replace(/\\n$/, '').split('\\n').at(-1); };",
        // A grandchild that inherits PATH reads through the shim. On macOS it sees
        // a missing item, as the real tool reports one; on Linux an empty read.
        `const inherited = spawnSync(process.execPath, ['-e', 'const read = require("node:child_process").spawnSync(process.argv[1], process.argv.slice(2), { encoding: "utf8" }); process.stdout.write(JSON.stringify({ status: read.status, stdout: read.stdout, stderr: read.stderr }))', command, read], { encoding: 'utf8', timeout: ${SPAWN_GUARD_MS} });`,
        'expect({ error: inherited.error, status: inherited.status }, inherited.stderr).toEqual({ error: undefined, status: 0 });',
        'const inheritedRead = JSON.parse(inherited.stdout);',
        `expect({ status: inheritedRead.status, stdout: inheritedRead.stdout, message: message(inheritedRead) }).toEqual(platform === 'darwin' ? { status: 44, stdout: '', message: ${JSON.stringify(NOT_FOUND)} } : { status: 0, stdout: '', message: undefined });`,
        // The count witnesses the drain, so it comes first; neither output may carry the input.
        "const write = platform === 'darwin' ? 'add-generic-password' : 'store';",
        `const written = spawnSync(command, [write], { input: ${JSON.stringify(WRITE_FIXTURE)}, encoding: 'utf8', timeout: ${SPAWN_GUARD_MS} });`,
        'const outcome = JSON.stringify({ write, status: written.status, signal: written.signal, error: written.error?.code ?? null });',
        `expect(message(written), outcome).toBe(${JSON.stringify(`${REJECTION} (discarded ${Buffer.byteLength(WRITE_FIXTURE)} bytes of stdin)`)});`,
        `expect({ error: written.error, status: written.status, stdout: written.stdout, echoed: (written.stderr ?? '').includes(${JSON.stringify(WRITE_FIXTURE.split('\n')[0])}) }, outcome).toEqual({ error: undefined, status: 1, stdout: '', echoed: false });`,
        // A regular file as stdin shares its offset with the parent, so what the
        // parent can still read afterwards is what the command left unread.
        'const withFileStdin = operation => {',
        "const fd = openSync(process.env.WHATSOUP_CREDENTIAL_PROBE_STDIN, 'r');",
        'try {',
        `const result = spawnSync(command, [operation], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: ${SPAWN_GUARD_MS} });`,
        'const chunk = Buffer.alloc(65_536);',
        'let unread = 0;',
        'for (let bytes = readSync(fd, chunk, 0, chunk.length, null); bytes > 0; bytes = readSync(fd, chunk, 0, chunk.length, null)) unread += bytes;',
        "return { operation, error: result.error?.code ?? null, status: result.status, signal: result.signal, stdout: result.stdout, echoed: /x{64}/.test(result.stderr ?? ''), message: message(result), unread };",
        '} finally { closeSync(fd); }',
        '};',
        // A write reads all of a large input.
        `expect(withFileStdin(write)).toEqual({ operation: write, error: null, status: 1, signal: null, stdout: '', echoed: false, message: ${JSON.stringify(`${REJECTION} (discarded ${STDIN_FILE_BYTES} bytes of stdin)`)}, unread: 0 });`,
        // The other operations take no stdin from real callers and read none of it.
        "for (const operation of platform === 'darwin' ? ['delete-generic-password', 'synthetic-unsupported-operation'] : ['clear', 'synthetic-unsupported-operation']) {",
        `expect(withFileStdin(operation)).toEqual({ operation, error: null, status: 1, signal: null, stdout: '', echoed: false, message: ${JSON.stringify(REJECTION)}, unread: ${STDIN_FILE_BYTES} });`,
        '}',
        // A write whose stdin is closed must not try to read: in macOS sh the pipe
        // of a command substitution then takes descriptor 0, so a reader waits on
        // its own pipeline forever. The spawn timeout ends only the direct child,
        // so `detached` (which spawnSync honours, though its options do not list it)
        // gives the write its own group, killed here; a group still alive fails.
        `const closed = spawnSync('/bin/sh', ['-c', 'exec "$0" "$1" <&-', command, write], { detached: true, encoding: 'utf8', timeout: ${SPAWN_GUARD_MS} });`,
        'let groupAlive = false;',
        "if (closed.pid > 0) { try { process.kill(-closed.pid, 'SIGKILL'); groupAlive = true; } catch (error) { groupAlive = error.code !== 'ESRCH'; } }",
        `expect({ error: closed.error?.code ?? null, status: closed.status, signal: closed.signal, stdout: closed.stdout, message: message(closed), groupAlive }).toEqual({ error: null, status: 1, signal: null, stdout: '', message: ${JSON.stringify(`${REJECTION} (discarded 0 bytes of stdin)`)}, groupAlive: false });`,
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
          WHATSOUP_CREDENTIAL_PROBE_STDIN: stdinFile,
          REQUIRE_OS_KEYRING: '1',
        },
        encoding: 'utf8', timeout: NESTED_RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024,
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
    TEST_TIMEOUT_MS,
  );
});
