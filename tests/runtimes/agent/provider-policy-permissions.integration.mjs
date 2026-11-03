import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, chownSync, closeSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run only in the disposable Linux CI container. The fixture never executes a
// launcher; nosuid/noexec and disabled networking keep this a DAC contract test.
assert.equal(process.platform, 'linux', 'Linux policy qualification is unavailable on this platform');
assert.equal(process.getuid(), 0, 'The disposable fixture must start as container root');

const script = fileURLToPath(import.meta.url);
const mode = process.argv[2];
const controllerUid = 10001;
const controllerGid = 10001;
const workerUid = 10002;
const workerGid = 10002;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function become(uid, gid) {
  process.setgroups([gid]);
  process.setgid(gid);
  process.setuid(uid);
  assert.equal(process.getuid(), uid);
  assert.equal(process.geteuid(), uid);
  assert.equal(process.getgid(), gid);
  assert.deepEqual(process.getgroups(), [gid]);
}

if (mode === '--watchdog') {
  become(Number(process.argv[3]), Number(process.argv[4]));
  process.stdout.write(JSON.stringify({ uid: process.getuid(), gid: process.getgid() }));
  // Self-exit bounds the negative case if the parent cannot signal this UID.
  setTimeout(() => process.exit(73), 6_000);
} else if (mode === '--controller') {
  become(controllerUid, controllerGid);
  const config = JSON.parse(process.argv[4]);
  const { assertProviderProcessIsolationConfig } = await import(pathToFileURL(
    join(process.argv[3], 'src/runtimes/agent/provider-process-isolation.ts'),
  ).href);
  assertProviderProcessIsolationConfig(config);
  assert.equal(digest(readFileSync(config.policyPath)), config.policySha256);
  assert.throws(() => {
    const fd = openSync(config.policyPath, 'a');
    closeSync(fd);
  }, { code: 'EACCES' });
  process.stdout.write(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), digest: config.policySha256 }));
} else if (mode === '--worker') {
  become(workerUid, workerGid);
  for (const access of ['r', 'a']) {
    assert.throws(() => {
      const fd = openSync(process.argv[3], access);
      closeSync(fd);
    }, { code: 'EACCES' });
  }
  process.stdout.write(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), read: 'denied', write: 'denied' }));
} else if (mode === '--reader' || mode === '--root-reader') {
  if (mode === '--reader') become(controllerUid, controllerGid);
  else assert.equal(process.geteuid(), 0);
  const result = spawnSync('/policy-reader', [process.argv[3]], {
    env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 3_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
} else if (mode === '--binary-reader') {
  assert.equal(process.geteuid(), 0, 'The C binary validator needs root to inspect every negative path');
  const result = spawnSync('/policy-reader', ['--binary', process.argv[3]], {
    env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 3_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
} else {
  const sourceRoot = process.argv[2];
  assert.ok(sourceRoot, 'Pass the source root explicitly');
  await test('root-owned controller-readable policy preserves the real filesystem boundary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'policy-permissions-'));
    const failures = [];
    let nonRootProviderParent;
    try {
      chmodSync(directory, 0o755);
      const launcherPath = join(directory, 'inert-launcher');
      writeFileSync(launcherPath, 'inert fixture; never execute\n', { mode: 0o600 });
      chmodSync(launcherPath, 0o4755);
      const providerPath = join(directory, 'inert-provider');
      writeFileSync(providerPath, 'inert fixture; never execute\n', { mode: 0o755 });
      chmodSync(providerPath, 0o755);
      const policyPath = join(directory, 'policy');
      const protectedPath = join(directory, 'protected-fixture');
      writeFileSync(protectedPath, 'fake credential; never a real secret\n', { mode: 0o600 });
      const workerDirectories = ['home', 'config', 'data'].map((name) => join(directory, name));
      for (const path of workerDirectories) {
        mkdirSync(path, { mode: 0o700 });
        chownSync(path, workerUid, workerGid);
      }
      writeFileSync(policyPath, [
        `controller_uid=${controllerUid}`, `controller_gid=${controllerGid}`,
        `worker_uid=${workerUid}`, `worker_gid=${workerGid}`,
        `home_dir=${workerDirectories[0]}`, `config_home=${workerDirectories[1]}`,
        `data_home=${workerDirectories[2]}`, `protected_path=${protectedPath}`,
        `allowed_binary=${providerPath}`, '',
      ].join('\n'), { mode: 0o600 });
      const config = {
        controllerUid, controllerGid, workerUid, workerGid,
        launcherPath, launcherSha256: digest(readFileSync(launcherPath)),
        policyPath, policySha256: digest(readFileSync(policyPath)),
        homeDir: workerDirectories[0], configHome: workerDirectories[1], dataHome: workerDirectories[2],
        protectedPaths: [protectedPath],
      };
      function policy(owner, group, permissions) {
        chownSync(policyPath, owner, group);
        chmodSync(policyPath, permissions);
        const metadata = lstatSync(policyPath);
        assert.equal(metadata.uid, owner);
        assert.equal(metadata.gid, group);
        assert.equal(metadata.mode & 0o7777, permissions);
      }
      function child(args) {
        const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], {
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: tmpdir() },
          encoding: 'utf8', timeout: 5_000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        return result;
      }
      function controller(candidate = config) {
        return child(['--controller', sourceRoot, JSON.stringify(candidate)]);
      }
      function binaryReader(path) {
        return child(['--binary-reader', path]);
      }
      function expectBinaryDenied(path, label) {
        const denied = binaryReader(path);
        assert.equal(denied.status, 126, `unexpected selected-binary admission for ${label}`);
        assert.match(denied.stderr, /whatsoup-agent-isolation-launcher: provider binary/);
      }
      for (const [uid, gid] of [[controllerUid, controllerGid], [workerUid, workerGid]]) {
        const timed = spawnSync(process.execPath, [script, '--watchdog', String(uid), String(gid)], {
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: tmpdir() },
          encoding: 'utf8', timeout: 2_000,
        });
        assert.deepEqual(JSON.parse(timed.stdout), { uid, gid });
        assert.equal(timed.error?.code, 'ETIMEDOUT');
        assert.equal(timed.status, null);
        assert.equal(timed.signal, 'SIGTERM', 'The watchdog must terminate the dropped-UID child');
      }
      policy(0, controllerGid, 0o640);
      const accepted = controller();
      assert(accepted.status === 0, accepted.stderr);
      assert.deepEqual(JSON.parse(accepted.stdout), {
        uid: controllerUid, gid: controllerGid, groups: [controllerGid], digest: config.policySha256,
      });
      const reader = child(['--reader', policyPath]);
      assert.equal(reader.status, 0, reader.stderr);
      assert.equal(reader.stdout, `${controllerGid}\n`);
      const rootReader = child(['--root-reader', policyPath]);
      assert.equal(rootReader.status, 0, rootReader.stderr);
      assert.equal(rootReader.stdout, `${controllerGid}\n`);
      const worker = child(['--worker', policyPath]);
      assert.equal(worker.status, 0, worker.stderr);
      assert.deepEqual(JSON.parse(worker.stdout), {
        uid: workerUid, gid: workerGid, groups: [workerGid], read: 'denied', write: 'denied',
      });
      const binaryAccepted = binaryReader(providerPath);
      assert.equal(binaryAccepted.status, 0, binaryAccepted.stderr);

      expectBinaryDenied(launcherPath, 'setuid selected binary');

      const selectedBinaryDirectory = join(directory, 'selected-binary-fixtures');
      mkdirSync(selectedBinaryDirectory, { mode: 0o755 });
      const selectedBinary = join(selectedBinaryDirectory, 'provider');
      writeFileSync(selectedBinary, 'inert fixture; never execute\n', { mode: 0o755 });
      chmodSync(selectedBinary, 0o755);
      const binarySymlink = join(selectedBinaryDirectory, 'provider-symlink');
      symlinkSync(selectedBinary, binarySymlink);
      expectBinaryDenied(binarySymlink, 'symlink selected binary');

      const nonRootBinary = join(selectedBinaryDirectory, 'provider-non-root');
      writeFileSync(nonRootBinary, 'inert fixture; never execute\n', { mode: 0o755 });
      chmodSync(nonRootBinary, 0o755);
      chownSync(nonRootBinary, controllerUid, controllerGid);
      expectBinaryDenied(nonRootBinary, 'non-root selected binary');

      const groupWritableBinary = join(selectedBinaryDirectory, 'provider-group-writable');
      writeFileSync(groupWritableBinary, 'inert fixture; never execute\n', { mode: 0o775 });
      chmodSync(groupWritableBinary, 0o775);
      expectBinaryDenied(groupWritableBinary, 'group-writable selected binary');

      const nonExecutableBinary = join(selectedBinaryDirectory, 'provider-non-executable');
      writeFileSync(nonExecutableBinary, 'inert fixture; never execute\n', { mode: 0o644 });
      chmodSync(nonExecutableBinary, 0o644);
      expectBinaryDenied(nonExecutableBinary, 'non-executable selected binary');

      const writableParent = join(directory, 'writable-provider-parent');
      mkdirSync(writableParent, { mode: 0o777 });
      chmodSync(writableParent, 0o777);
      const writableParentBinary = join(writableParent, 'provider');
      writeFileSync(writableParentBinary, 'inert fixture; never execute\n', { mode: 0o755 });
      chmodSync(writableParentBinary, 0o755);
      expectBinaryDenied(writableParentBinary, 'group/other-writable parent directory');

      const symlinkParentTarget = join(directory, 'provider-parent-target');
      mkdirSync(symlinkParentTarget, { mode: 0o755 });
      const symlinkParentBinary = join(symlinkParentTarget, 'provider');
      writeFileSync(symlinkParentBinary, 'inert fixture; never execute\n', { mode: 0o755 });
      chmodSync(symlinkParentBinary, 0o755);
      const symlinkParent = join(directory, 'provider-parent-symlink');
      symlinkSync(symlinkParentTarget, symlinkParent);
      expectBinaryDenied(join(symlinkParent, 'provider'), 'symlink parent directory');

      nonRootProviderParent = join(directory, 'non-root-provider-parent');
      mkdirSync(nonRootProviderParent, { mode: 0o755 });
      const nonRootParentBinary = join(nonRootProviderParent, 'provider');
      writeFileSync(nonRootParentBinary, 'inert fixture; never execute\n', { mode: 0o755 });
      chmodSync(nonRootParentBinary, 0o755);
      chownSync(nonRootProviderParent, controllerUid, controllerGid);
      expectBinaryDenied(nonRootParentBinary, 'non-root parent directory');

      for (const [owner, group, permissions] of [
        [0, controllerGid, 0o600], [0, 0, 0o640], [controllerUid, controllerGid, 0o640],
        [0, controllerGid, 0o660], [0, controllerGid, 0o644], [0, controllerGid, 0o2640],
      ]) {
        policy(owner, group, permissions);
        const denied = controller();
        assert.equal(denied.status, 1, `unexpected admission for ${owner}:${group} mode ${permissions.toString(8)}`);
        assert.match(denied.stderr, /ProviderProcessIsolationError: process isolation policy/);
        const readerDenied = child(['--reader', policyPath]);
        assert.equal(readerDenied.status, 126, `unexpected C admission for ${owner}:${group} mode ${permissions.toString(8)}`);
        assert.match(readerDenied.stderr, /whatsoup-agent-isolation-launcher: policy/);
        // Root can read the root-owned fixture even when DAC denies the
        // controller, so this reaches the launcher's own metadata checks.
        const rootDenied = child(['--root-reader', policyPath]);
        assert.equal(rootDenied.status, 126, `unexpected root C admission for ${owner}:${group} mode ${permissions.toString(8)}`);
        assert.match(rootDenied.stderr, /whatsoup-agent-isolation-launcher: policy/);
      }
      policy(0, controllerGid, 0o640);
      const changed = controller({ ...config, policySha256: '0'.repeat(64) });
      assert.equal(changed.status, 1);
      assert.match(changed.stderr, /policy digest changed/);
    } catch (error) {
      failures.push(error);
    } finally {
      if (nonRootProviderParent !== undefined) {
        try {
          chownSync(nonRootProviderParent, 0, 0);
        } catch (error) {
          if (error.code !== 'ENOENT') failures.push(error);
        }
      }
      // Root has no DAC override here. Unlink the empty private directories
      // through their root-owned parent without traversing worker permissions.
      for (const name of ['home', 'config', 'data']) {
        try {
          rmdirSync(join(directory, name));
        } catch (error) {
          if (error.code !== 'ENOENT') failures.push(error);
        }
      }
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Policy qualification and cleanup failed');
  });
}
