import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const launcherSource = fileURLToPath(new URL(
  '../../../deploy/agent-isolation/whatsoup-agent-isolation-launcher.c',
  import.meta.url,
));

describe('Linux agent-process isolation launcher artifact', () => {
  it('rejects readable protected files even when writing is denied', () => {
    const directory = mkdtempSync(join(tmpdir(), 'isolation-permission-probe-'));
    try {
      const source = readFileSync(launcherSource, 'utf8');
      const start = source.indexOf('static void prove_protected_paths_denied(');
      const end = source.indexOf('\nstatic void ', start + 1);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const probe = join(directory, 'probe.c');
      const binary = join(directory, 'probe');
      const secret = join(directory, 'protected');
      writeFileSync(secret, 'fixture');
      chmodSync(secret, 0o400);
      writeFileSync(probe, [
        '#include <errno.h>', '#include <fcntl.h>', '#include <stddef.h>', '#include <unistd.h>',
        'struct policy { const char *protected_paths[1]; size_t protected_path_count; };',
        'static void fail(const char *message) { (void)message; _exit(126); }',
        source.slice(start, end),
        'int main(int argc, char **argv) { if (argc != 2) return 2; struct policy p = {{argv[1]}, 1}; prove_protected_paths_denied(&p); return 0; }',
      ].join('\n'));
      execFileSync('/usr/bin/cc', ['-Wall', '-Werror', probe, '-o', binary], { timeout: 5_000 });
      expect(spawnSync(binary, [secret], { timeout: 5_000 }).status).toBe(126);
      chmodSync(secret, 0o200);
      expect(spawnSync(binary, [secret], { timeout: 5_000 }).status).toBe(126);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('has a concrete fail-closed privilege-drop implementation rather than an environment-only claim', () => {
    const source = readFileSync(launcherSource, 'utf8');

    expect(source).toContain('setgroups(1, groups)');
    expect(source).toContain('setresgid(policy.worker_gid, policy.worker_gid, policy.worker_gid)');
    expect(source).toContain('setresuid(policy.worker_uid, policy.worker_uid, policy.worker_uid)');
    expect(source).toContain('faccessat(AT_FDCWD, policy->protected_paths[i], modes[mode]');
    expect(source).toContain('prove_controller_signal_denied(controller_pid)');
    expect(source).toContain('prove_other_process_environment_denied()');
    expect(source).toContain('PR_SET_NO_NEW_PRIVS');
    expect(source).toContain('clearenv()');
    expect(source).toContain('execve(argv[command_index], &argv[command_index], environ)');
  });

  it('requires an exact root:controllerGid 0640 nonsecret policy, controller identity, and a controller-readable receipt fd', () => {
    const source = readFileSync(launcherSource, 'utf8');

    expect(source).toContain('policy_metadata.st_uid != 0');
    expect(source).toContain('(policy_metadata.st_mode & 0022) != 0');
    expect(source).toContain('opened_metadata.st_gid != policy->controller_gid');
    expect(source).toContain('(opened_metadata.st_mode & 07777) != 0640');
    expect(source).toContain('getuid() != policy.controller_uid');
    expect(source).toContain('write_receipt(receipt_fd, nonce, &policy)');
    expect(source).toContain('FD_CLOEXEC');
  });

  it('validates the policy-selected provider binary before dropping the controller identity', () => {
    const source = readFileSync(launcherSource, 'utf8');
    const policyMembership = source.indexOf('if (!command_is_allowed(&policy, argv[command_index]))');
    const binaryValidation = source.indexOf('require_secure_provider_binary(argv[command_index]);');
    const gidDrop = source.indexOf('setresgid(policy.worker_gid, policy.worker_gid, policy.worker_gid)');

    expect(source).toContain('static void require_secure_provider_binary(const char *path)');
    expect(source).toContain('lstat(path, &metadata)');
    expect(source).toContain('!S_ISREG(metadata.st_mode)');
    expect(source).toContain('metadata.st_uid != 0');
    expect(source).toContain('(metadata.st_mode & 0022) != 0');
    expect(source).toContain('(metadata.st_mode & 06000) != 0');
    expect(source).toContain('(metadata.st_mode & 0111) == 0');
    expect(source).toContain('require_secure_parent_directories(path, "provider binary parent directories are not root-owned and non-writable")');
    expect(policyMembership).toBeGreaterThan(0);
    expect(binaryValidation).toBeGreaterThan(policyMembership);
    expect(gidDrop).toBeGreaterThan(binaryValidation);
  });
});
