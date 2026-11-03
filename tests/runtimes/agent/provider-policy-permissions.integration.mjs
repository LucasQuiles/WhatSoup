import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, chownSync, closeSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, rmdirSync, rmSync, writeFileSync,
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
} else {
  const sourceRoot = process.argv[2];
  assert.ok(sourceRoot, 'Pass the source root explicitly');
  await test('root-owned controller-readable policy preserves the real filesystem boundary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'policy-permissions-'));
    const failures = [];
    try {
      chmodSync(directory, 0o755);
      const launcherPath = join(directory, 'inert-launcher');
      writeFileSync(launcherPath, 'inert fixture; never execute\n', { mode: 0o600 });
      chmodSync(launcherPath, 0o4755);
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
        `allowed_binary=${launcherPath}`, '',
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
      assert.equal(accepted.status, 0, accepted.stderr);
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
