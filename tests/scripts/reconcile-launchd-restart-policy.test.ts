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
});
