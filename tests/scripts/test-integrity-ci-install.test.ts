import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

it('authenticates the private dependency host with the published GitHub key and strict checking', () => {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-ci-host-key-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const fixture = (name: string, body: string): void => {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
    };
    const workflow = parse(readFileSync(join(repoRoot, '.github/workflows/quality.yml'), 'utf8'));
    const step = workflow.jobs.quality.steps.find((value: { name?: string }) => value.name === 'Install test-integrity plugin');
    fixture('ssh-keyscan', 'printf unsafe > "$KEYSCAN_MARKER"\nprintf "%s\\n" "github.com ssh-ed25519 UNTRUSTED_NETWORK_KEY"');
    fixture('git', `
case "$*" in
  *" fetch "*)
    printf '%s' "$GIT_SSH_COMMAND" > "$SSH_CAPTURE"
    for option in $GIT_SSH_COMMAND; do
      case "$option" in UserKnownHostsFile=*) cp "\${option#UserKnownHostsFile=}" "$KNOWN_CAPTURE" ;; esac
    done
    ;;
  *" rev-parse HEAD") printf '%s\\n' "$TEST_INTEGRITY_COMMIT" ;;
esac
`);
    const result = spawnSync('/bin/bash', ['-e', '-c', step.run], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        TEST_INTEGRITY_DEPLOY_KEY: 'test-only-placeholder',
        TEST_INTEGRITY_COMMIT: step.env.TEST_INTEGRITY_COMMIT,
        SSH_CAPTURE: join(root, 'ssh-command'),
        KNOWN_CAPTURE: join(root, 'known-hosts'),
        KEYSCAN_MARKER: join(root, 'keyscan-ran'),
      },
      encoding: 'utf8',
      timeout: 4000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const key = spawnSync('ssh-keygen', ['-lf', join(root, 'known-hosts')], { encoding: 'utf8' });
    expect(key.status, key.stderr).toBe(0);
    expect(key.stdout).toContain('SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU');
    const command = readFileSync(join(root, 'ssh-command'), 'utf8').split(/\s+/);
    const options = spawnSync('/usr/bin/ssh', ['-G', ...command.slice(1), 'github.com'], { encoding: 'utf8' });
    expect(options.status, options.stderr).toBe(0);
    expect(options.stdout).toMatch(/^stricthostkeychecking true$/m);
    expect(options.stdout).toMatch(/^globalknownhostsfile \/dev\/null$/m);
    expect(existsSync(join(root, 'keyscan-ran'))).toBe(false);
    expect(existsSync(join(root, '.ssh/test_integrity_deploy'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
