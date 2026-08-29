import { describe, expect, it, vi } from 'vitest';
import {
  parseReconcileLaunchdRestartPolicyArgs,
  runReconcileLaunchdRestartPolicy,
} from '../../scripts/reconcile-launchd-restart-policy.ts';

describe('reconcile-launchd-restart-policy CLI', () => {
  it('defaults to a non-mutating dry run for one valid instance', () => {
    expect(parseReconcileLaunchdRestartPolicyArgs(['--instance', 'agent-one'])).toEqual({
      instance: 'agent-one',
      apply: false,
      help: false,
    });
  });

  it('requires explicit apply and rejects duplicate or unsafe instance input', () => {
    expect(parseReconcileLaunchdRestartPolicyArgs(['--instance', 'agent-one', '--apply'])).toMatchObject({
      instance: 'agent-one',
      apply: true,
    });
    expect(() => parseReconcileLaunchdRestartPolicyArgs(['--instance', 'a', '--instance', 'b'])).toThrow('only once');
    expect(() => parseReconcileLaunchdRestartPolicyArgs(['--instance', '../agent'])).toThrow('invalid instance name');
  });

  it('does not invoke a reconciler on a non-macOS host', async () => {
    const reconcile = vi.fn();
    const stderr = vi.fn();

    await expect(runReconcileLaunchdRestartPolicy(['--instance', 'agent-one'], {
      platform: 'linux',
      reconcile,
      stdout: vi.fn(),
      stderr,
    })).resolves.toBe(2);

    expect(reconcile).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('macOS'));
  });

  it('delegates dry-run and apply modes to the existing-plist reconciler', async () => {
    const reconcile = vi.fn().mockResolvedValue({
      label: 'com.whatsoup.agent-one',
      plistPath: '/safe/agent-one.plist',
      priorPlistExisted: true,
      dryRun: true,
    });
    const stdout = vi.fn();
    const deps = { platform: 'darwin' as NodeJS.Platform, reconcile, stdout, stderr: vi.fn() };

    await expect(runReconcileLaunchdRestartPolicy(['--instance', 'agent-one'], deps)).resolves.toBe(0);
    expect(reconcile).toHaveBeenLastCalledWith('agent-one', { dryRun: true });

    await expect(runReconcileLaunchdRestartPolicy(['--instance', 'agent-one', '--apply'], deps)).resolves.toBe(0);
    expect(reconcile).toHaveBeenLastCalledWith('agent-one', { dryRun: false });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('com.whatsoup.agent-one'));
  });

  it('prints governed-env drift by key and digest only', async () => {
    const reconcile = vi.fn().mockResolvedValue({
      label: 'com.whatsoup.agent-one',
      plistPath: '/safe/agent-one.plist',
      priorPlistExisted: true,
      dryRun: true,
      governedEnvDrift: {
        comparable: true,
        drift: [
          { key: 'PATH', state: 'mismatch', expectedDigest: 'a'.repeat(64), observedDigest: 'b'.repeat(64) },
          { key: 'CLAUDE_CONFIG_DIR', state: 'missing', expectedDigest: 'c'.repeat(64), observedDigest: null },
        ],
      },
    });
    const stdout = vi.fn();

    await expect(runReconcileLaunchdRestartPolicy(['--instance', 'agent-one'], {
      platform: 'darwin',
      reconcile,
      stdout,
      stderr: vi.fn(),
    })).resolves.toBe(0);

    const lines = stdout.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('governed env drift: PATH mismatch'))).toBe(true);
    expect(lines.some((line) => line.includes('governed env drift: CLAUDE_CONFIG_DIR missing'))).toBe(true);
    expect(lines.some((line) => line.includes('a'.repeat(64).slice(0, 12)))).toBe(true);
  });

  it('reports an explicit all-clear when governed keys match', async () => {
    const reconcile = vi.fn().mockResolvedValue({
      label: 'com.whatsoup.agent-one',
      plistPath: '/safe/agent-one.plist',
      priorPlistExisted: true,
      dryRun: true,
      governedEnvDrift: { comparable: true, drift: [] },
    });
    const stdout = vi.fn();

    await runReconcileLaunchdRestartPolicy(['--instance', 'agent-one'], {
      platform: 'darwin',
      reconcile,
      stdout,
      stderr: vi.fn(),
    });

    const lines = stdout.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('governed env: no drift'))).toBe(true);
  });

  it('surfaces an unparseable installed EnvironmentVariables dict as fail-closed drift', async () => {
    const reconcile = vi.fn().mockResolvedValue({
      label: 'com.whatsoup.agent-one',
      plistPath: '/safe/agent-one.plist',
      priorPlistExisted: true,
      dryRun: true,
      governedEnvDrift: {
        comparable: false,
        reason: 'environment-variables-unparseable',
        drift: [],
      },
    });
    const stdout = vi.fn();

    await runReconcileLaunchdRestartPolicy(['--instance', 'agent-one'], {
      platform: 'darwin',
      reconcile,
      stdout,
      stderr: vi.fn(),
    });

    const lines = stdout.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('unparseable'))).toBe(true);
  });
});
