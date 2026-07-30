import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const osMocks = vi.hoisted(() => ({
  homedir: vi.fn(),
}));

vi.mock('node:child_process', () => childProcessMocks);
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: fsMocks.existsSync,
  mkdirSync: fsMocks.mkdirSync,
  readFileSync: fsMocks.readFileSync,
  renameSync: fsMocks.renameSync,
  writeFileSync: fsMocks.writeFileSync,
  unlinkSync: fsMocks.unlinkSync,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: osMocks.homedir,
}));

class MockChild extends EventEmitter {
  kill = vi.fn();
}

type PlatformModule = typeof import('../../src/fleet/platform.ts');

const originalPlatform = process.platform;
const originalDocker = process.env.WHATSOUP_DOCKER;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

async function importPlatform(): Promise<PlatformModule> {
  vi.resetModules();
  return import('../../src/fleet/platform.ts');
}

function resolveExecFile(): void {
  childProcessMocks.execFile.mockImplementation((_cmd, _args, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    queueMicrotask(() => callback?.(null, '', ''));
    return new EventEmitter();
  });
}

function absentFile(): never {
  const error = new Error('not found') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') throw new Error('missing test uid');
  return process.getuid();
}

function launchdAbsentError(message = 'no service'): Error & { code: number } {
  return Object.assign(new Error(message), { code: 3 });
}

function generatedPlistIdentity(name = 'agent'): string {
  return [
    '<plist>',
    '<key>Label</key>',
    `<string>com.whatsoup.${name}</string>`,
    '<key>ProgramArguments</key>',
    '<array>',
    '<string>/tmp/whatsoup-home/.local/bin/whatsoup</string>',
    `<string>${name}</string>`,
    '</array>',
    '</plist>',
  ].join('\n');
}

describe('platform service managers', () => {
  beforeEach(() => {
    vi.useRealTimers();
    setPlatform(originalPlatform);
    if (originalDocker === undefined) delete process.env.WHATSOUP_DOCKER;
    else process.env.WHATSOUP_DOCKER = originalDocker;

    childProcessMocks.execFile.mockReset();
    childProcessMocks.execFileSync.mockReset();
    childProcessMocks.spawn.mockReset();
    fsMocks.existsSync.mockReset();
    fsMocks.mkdirSync.mockReset();
    fsMocks.readFileSync.mockReset();
    fsMocks.renameSync.mockReset();
    fsMocks.writeFileSync.mockReset();
    fsMocks.unlinkSync.mockReset();
    osMocks.homedir.mockReset();

    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockImplementation(absentFile);
    osMocks.homedir.mockReturnValue('/tmp/whatsoup-home');
    resolveExecFile();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setPlatform(originalPlatform);
    if (originalDocker === undefined) delete process.env.WHATSOUP_DOCKER;
    else process.env.WHATSOUP_DOCKER = originalDocker;
  });

  it('detects linux systemd and re-enables template and fleet units through systemctl', async () => {
    setPlatform('linux');
    childProcessMocks.execFileSync.mockReturnValue(Buffer.from('DISPLAY=:0'));
    const { createServiceManager } = await importPlatform();
    const templateUnit = (name: string) => ['whatsoup', name].join('@') + '.service';

    const manager = createServiceManager();
    expect(createServiceManager()).toBe(manager);

    await manager.enable('alpha');
    await manager.disable('alpha');
    await manager.start('alpha');
    await manager.stop('alpha');
    await manager.restart('whatsoup-fleet');

    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'show-environment'], {
      timeout: 3_000,
      stdio: 'ignore',
    });
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'systemctl', ['--user', 'reenable', templateUnit('alpha')], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(2, 'systemctl', ['--user', 'disable', templateUnit('alpha')], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(3, 'systemctl', ['--user', 'start', templateUnit('alpha')], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(4, 'systemctl', ['--user', 'stop', templateUnit('alpha')], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(5, 'systemctl', ['--user', 'restart', 'whatsoup-fleet.service'], expect.any(Function));
  });

  it('returns the docker supervisor when the linux docker sentinel exists', async () => {
    setPlatform('linux');
    fsMocks.existsSync.mockImplementation((target: unknown) => target === '/.dockerenv');
    const { DockerSupervisorServiceManager, createServiceManager } = await importPlatform();

    expect(createServiceManager()).toBeInstanceOf(DockerSupervisorServiceManager);
    expect(childProcessMocks.execFileSync).not.toHaveBeenCalled();
  });

  it('throws a descriptive no-systemd error for unsupported linux service operations', async () => {
    setPlatform('linux');
    childProcessMocks.execFileSync.mockImplementation(() => {
      throw new Error('systemd unavailable');
    });
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();

    await expect(manager.enable('alpha')).rejects.toThrow('Service management requires systemd');
    await expect(manager.disable('alpha')).rejects.toThrow('Service management requires systemd');
    await expect(manager.start('alpha')).rejects.toThrow('Service management requires systemd');
    await expect(manager.stop('alpha')).rejects.toThrow('Service management requires systemd');
    await expect(manager.restart('alpha')).rejects.toThrow('Service management requires systemd');
    expect(() => manager.startFire('alpha')).toThrow('Service management requires systemd');
  });

  it('throws for unsupported platforms', async () => {
    setPlatform('freebsd');
    const { detectPlatform } = await importPlatform();

    expect(() => detectPlatform()).toThrow('Unsupported platform: freebsd');
  });

  it('defers launchd installation until start so create can finish authentication first', async () => {
    setPlatform('darwin');
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();

    await manager.enable('agent');
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();

    if (!manager.startAfterAuthFire) throw new Error('missing macOS authenticated-start hook');
    await new Promise<void>((resolve, reject) => {
      manager.startAfterAuthFire!('agent', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    await manager.stop('agent');
    await manager.restart('agent');
    await manager.disable('agent');

    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/tmp/whatsoup-home/Library/LaunchAgents', { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.com.whatsoup.agent.plist.tmp-'),
      expect.stringContaining('<string>com.whatsoup.agent</string>'),
      { encoding: 'utf-8', mode: 0o644 },
    );
    expect(fsMocks.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('.com.whatsoup.agent.plist.tmp-'),
      plist,
    );
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(plist);
    const domain = `gui/${currentUid()}`;
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(2, 'launchctl', ['kickstart', '-k', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(3, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(4, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(5, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(6, 'launchctl', ['kickstart', '-k', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(7, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).not.toHaveBeenCalledWith('launchctl', ['stop', 'com.whatsoup.agent'], expect.any(Function));
    expect(childProcessMocks.execFile).not.toHaveBeenCalledWith('launchctl', ['start', 'com.whatsoup.agent'], expect.any(Function));
  });

  it('refuses a generic restart before authenticated activation can install a launchd plist', async () => {
    setPlatform('darwin');
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();

    await manager.enable('agent');
    await expect(manager.restart('agent')).rejects.toThrow('authenticate the instance before starting');

    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(fsMocks.renameSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('boots out a loaded macOS job for authentication instead of letting KeepAlive relaunch it', async () => {
    setPlatform('darwin');
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();
    if (!manager.stopForAuth) throw new Error('missing macOS auth-stop hook');

    await manager.stopForAuth('agent');

    const domain = `gui/${currentUid()}`;
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'launchctl',
      ['bootout', `${domain}/com.whatsoup.agent`],
      expect.any(Function),
    );
  });

  it('rebootstraps an existing plist through authenticated activation after auth teardown', async () => {
    setPlatform('darwin');
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();
    if (!manager.startAfterAuthFire) throw new Error('missing macOS authenticated-start hook');

    if (!manager.stopForAuth) throw new Error('missing macOS auth-stop hook');
    await manager.stopForAuth('agent');

    await new Promise<void>((resolve, reject) => {
      manager.startAfterAuthFire!('agent', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const domain = `gui/${currentUid()}`;
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(
      1,
      'launchctl',
      ['bootout', `${domain}/com.whatsoup.agent`],
      expect.any(Function),
    );
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(
      2,
      'launchctl',
      ['bootstrap', domain, plist],
      expect.any(Function),
    );
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(
      3,
      'launchctl',
      ['kickstart', '-k', `${domain}/com.whatsoup.agent`],
      expect.any(Function),
    );
    expect(childProcessMocks.execFile).not.toHaveBeenCalledWith(
      'launchctl',
      ['start', 'com.whatsoup.agent'],
      expect.any(Function),
    );
  });

  it('bootstraps an existing unloaded plist after successful auth without treating it as a stopped job', async () => {
    setPlatform('darwin');
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    const absent = launchdAbsentError();
    childProcessMocks.execFile
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(absent, '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(absent, '', ''));
        return new EventEmitter();
      });
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();
    if (!manager.stopForAuth || !manager.startAfterAuthFire) throw new Error('missing macOS auth lifecycle hooks');

    await expect(manager.stopForAuth('agent')).resolves.toBe(false);
    await new Promise<void>((resolve, reject) => {
      manager.startAfterAuthFire!('agent', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const domain = `gui/${currentUid()}`;
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(2, 'launchctl', ['kickstart', '-k', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(3, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(4, 'launchctl', ['kickstart', '-k', `${domain}/com.whatsoup.agent`], expect.any(Function));
  });

  it('refuses authenticated activation of a foreign plist before invoking launchctl', async () => {
    setPlatform('darwin');
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue([
      '<plist>',
      '<key>Label</key>',
      '<string>com.whatsoup.agent</string>',
      '<key>ProgramArguments</key>',
      '<array><string>/usr/local/bin/foreign</string><string>agent</string></array>',
      '</plist>',
    ].join('\n'));
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();
    if (!manager.startAfterAuthFire) throw new Error('missing macOS authenticated-start hook');

    const activation = new Promise<void>((resolve, reject) => {
      manager.startAfterAuthFire!('agent', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await expect(activation).rejects.toThrow('does not match the generated WhatSoup instance identity');
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it('dry-runs a required existing launchd plist without modifying it', async () => {
    setPlatform('darwin');
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', { dryRun: true })).resolves.toMatchObject({
      label: 'com.whatsoup.agent',
      dryRun: true,
      priorPlistExisted: true,
    });

    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(fsMocks.renameSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('requires an existing plist for an explicit launchd migration', async () => {
    setPlatform('darwin');
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {})).rejects.toThrow('no existing launchd plist');

    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('refuses a migration when the expected pathname contains a non-generated plist', async () => {
    setPlatform('darwin');
    fsMocks.readFileSync.mockReturnValue([
      '<plist>',
      '<key>Label</key>',
      '<string>com.whatsoup.agent</string>',
      '<key>ProgramArguments</key>',
      '<array><string>/usr/local/bin/other-program</string><string>agent</string></array>',
      '</plist>',
    ].join('\n'));
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {}))
      .rejects.toThrow('does not match the generated WhatSoup instance identity');

    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(fsMocks.renameSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('rejects an unsafe direct reconciler name before constructing a path or invoking launchctl', async () => {
    setPlatform('darwin');
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('../../outside', {})).rejects.toThrow('invalid instance name');

    expect(fsMocks.readFileSync).not.toHaveBeenCalled();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('refuses direct reconciliation outside macOS before touching disk or launchctl', async () => {
    setPlatform('linux');
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {})).rejects.toThrow('only available on macOS');

    expect(fsMocks.readFileSync).not.toHaveBeenCalled();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('restores the prior plist and job when launchd reload fails', async () => {
    setPlatform('darwin');
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    childProcessMocks.execFile
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(null, '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(new Error('bootstrap rejected'), '', ''));
        return new EventEmitter();
      });
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {})).rejects.toThrow('bootstrap rejected');

    expect(fsMocks.writeFileSync).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('.com.whatsoup.agent.plist.tmp-'),
      expect.stringContaining('<key>SuccessfulExit</key>'),
      { encoding: 'utf-8', mode: 0o644 },
    );
    expect(fsMocks.renameSync).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('.com.whatsoup.agent.plist.tmp-'),
      plist,
    );
    expect(fsMocks.writeFileSync).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('.com.whatsoup.agent.plist.tmp-'),
      generatedPlistIdentity(),
      { encoding: 'utf-8', mode: 0o644 },
    );
    expect(fsMocks.renameSync).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('.com.whatsoup.agent.plist.tmp-'),
      plist,
    );
    const domain = `gui/${currentUid()}`;
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(3, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(4, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(5, 'launchctl', ['kickstart', '-k', `${domain}/com.whatsoup.agent`], expect.any(Function));
  });

  it('still restores the prior plist and attempts its restart when new-job cleanup fails', async () => {
    setPlatform('darwin');
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    childProcessMocks.execFile
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(null, '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(new Error('bootstrap rejected'), '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(new Error('cleanup bootout rejected'), '', ''));
        return new EventEmitter();
      });
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {})).rejects.toThrow('rollback also failed');

    const domain = `gui/${currentUid()}`;
    expect(fsMocks.renameSync).toHaveBeenNthCalledWith(2, expect.stringContaining('.com.whatsoup.agent.plist.tmp-'), plist);
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(2, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(3, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(4, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(5, 'launchctl', ['kickstart', '-k', `${domain}/com.whatsoup.agent`], expect.any(Function));
  });

  it('boots out a partially loaded new job before restoring after kickstart fails', async () => {
    setPlatform('darwin');
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    childProcessMocks.execFile
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(null, '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(null, '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(new Error('kickstart rejected'), '', ''));
        return new EventEmitter();
      });
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {})).rejects.toThrow('kickstart rejected');

    const domain = `gui/${currentUid()}`;
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(2, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(3, 'launchctl', ['kickstart', '-k', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(4, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(fsMocks.renameSync).toHaveBeenNthCalledWith(2, expect.stringContaining('.com.whatsoup.agent.plist.tmp-'), plist);
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(5, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(6, 'launchctl', ['kickstart', '-k', `${domain}/com.whatsoup.agent`], expect.any(Function));
  });

  it('restores only the plist and aborts when the initial launchd bootout fails', async () => {
    setPlatform('darwin');
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    childProcessMocks.execFile.mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      queueMicrotask(() => callback?.(new Error('bootout rejected'), '', ''));
      return new EventEmitter();
    });
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {})).rejects.toThrow('bootout rejected');

    const domain = `gui/${currentUid()}`;
    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1);
    expect(childProcessMocks.execFile).toHaveBeenCalledWith('launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(fsMocks.renameSync).toHaveBeenNthCalledWith(2, expect.stringContaining('.com.whatsoup.agent.plist.tmp-'), plist);
  });

  it('removes a bootstrap-loaded launchd job before unlinking its plist', async () => {
    setPlatform('darwin');
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().disable('agent')).resolves.toBeUndefined();

    const domain = `gui/${currentUid()}`;
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    expect(childProcessMocks.execFile).toHaveBeenCalledWith('launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(plist);
  });

  it('does not boot out or unlink a launchd label without a generated plist identity', async () => {
    setPlatform('darwin');
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().disable('agent')).resolves.toBeUndefined();

    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
  });

  it('does not boot out a launchd label without a generated plist identity when stopping', async () => {
    setPlatform('darwin');
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().stop('agent')).resolves.toBeUndefined();

    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('treats only an explicit absent launchd job as an idempotent disable', async () => {
    setPlatform('darwin');
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity('missing'));
    const absent = launchdAbsentError('localized launchctl absence');
    childProcessMocks.execFile.mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      queueMicrotask(() => callback?.(absent, '', ''));
      return new EventEmitter();
    });
    fsMocks.unlinkSync.mockImplementation(() => {
      const error = new Error('not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().disable('missing')).resolves.toBeUndefined();
  });

  it('does not unlink a plist after an unexpected launchd bootout failure', async () => {
    setPlatform('darwin');
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    childProcessMocks.execFile.mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      queueMicrotask(() => callback?.(new Error('permission denied'), '', ''));
      return new EventEmitter();
    });
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().disable('agent')).rejects.toThrow('permission denied');

    expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
  });

  it('rejects an unsafe direct macOS service-manager name before filesystem or launchctl access', async () => {
    setPlatform('darwin');
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().disable('../../outside')).rejects.toThrow('invalid instance name');

    expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('removes a newly written plist even when first-install cleanup bootout fails', async () => {
    setPlatform('darwin');
    childProcessMocks.execFile
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(null, '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(new Error('kickstart rejected'), '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(new Error('cleanup bootout rejected'), '', ''));
        return new EventEmitter();
      });
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();
    if (!manager.startAfterAuthFire) throw new Error('missing macOS authenticated-start hook');
    const firstStart = new Promise<void>((resolve, reject) => {
      manager.startAfterAuthFire!('agent', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await expect(firstStart).rejects.toThrow('rollback also failed');

    const domain = `gui/${currentUid()}`;
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(2, 'launchctl', ['kickstart', '-k', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(3, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(plist);
  });

  it('attempts first-install cleanup after bootstrap rejects and preserves the original error when no job exists', async () => {
    setPlatform('darwin');
    const bootstrapFailure = new Error('bootstrap rejected');
    const absent = launchdAbsentError();
    childProcessMocks.execFile
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(bootstrapFailure, '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(absent, '', ''));
        return new EventEmitter();
      });
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();
    if (!manager.startAfterAuthFire) throw new Error('missing macOS authenticated-start hook');
    const firstStart = new Promise<void>((resolve, reject) => {
      manager.startAfterAuthFire!('agent', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await expect(firstStart).rejects.toThrow('bootstrap rejected');

    const domain = `gui/${currentUid()}`;
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(2, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(plist);
  });

  it('continues launchd restart when stop reports an already-stopped service', async () => {
    setPlatform('darwin');
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(generatedPlistIdentity());
    const absent = launchdAbsentError();
    childProcessMocks.execFile
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(absent, '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(null, '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(null, '', ''));
        return new EventEmitter();
      });
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().restart('agent')).resolves.toBeUndefined();
    const domain = `gui/${currentUid()}`;
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(2, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(3, 'launchctl', ['kickstart', '-k', `${domain}/com.whatsoup.agent`], expect.any(Function));
  });

  it('spawns docker instances from the repo root and removes them from the cache on exit', async () => {
    process.env.WHATSOUP_DOCKER = '1';
    const children: MockChild[] = [];
    childProcessMocks.spawn.mockImplementation(() => {
      const child = new MockChild();
      children.push(child);
      return child;
    });
    const { DockerSupervisorServiceManager } = await importPlatform();
    const manager = new DockerSupervisorServiceManager();

    const firstStart = manager.start('bot-a');
    children[0].emit('spawn');
    await firstStart;
    await manager.start('bot-a');

    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
    const [, args, options] = childProcessMocks.spawn.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining([
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      expect.stringContaining('/src/bootstrap.ts'),
      'bot-a',
    ]));
    const bootstrapScript = String(args[2]);
    expect(options).toEqual(expect.objectContaining({
      cwd: bootstrapScript.slice(0, -'/src/bootstrap.ts'.length),
      stdio: 'inherit',
    }));

    children[0].emit('exit');
    const secondStart = manager.start('bot-a');
    children[1].emit('spawn');
    await secondStart;
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('rejects docker start when the child process emits an error', async () => {
    const children: MockChild[] = [];
    childProcessMocks.spawn.mockImplementation(() => {
      const child = new MockChild();
      children.push(child);
      return child;
    });
    const { DockerSupervisorServiceManager } = await importPlatform();
    const manager = new DockerSupervisorServiceManager();

    const start = manager.start('bot-a');
    const failure = new Error('spawn denied');
    children[0].emit('error', failure);

    await expect(start).rejects.toThrow('spawn denied');
  });

  it('routes non-Error docker startFire failures as Error instances', async () => {
    const { DockerSupervisorServiceManager } = await importPlatform();
    const manager = new DockerSupervisorServiceManager();
    vi.spyOn(manager, 'start').mockRejectedValue('spawn denied');
    const onError = vi.fn();

    manager.startFire('bot-a', onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
    expect(onError.mock.calls[0][0].message).toBe('spawn denied');
  });

  it('stops docker instances with SIGTERM and resolves on child exit', async () => {
    const child = new MockChild();
    childProcessMocks.spawn.mockReturnValue(child);
    const { DockerSupervisorServiceManager } = await importPlatform();
    const manager = new DockerSupervisorServiceManager();

    const start = manager.start('bot-a');
    child.emit('spawn');
    await start;

    const stop = manager.stop('bot-a');
    child.emit('exit');
    await stop;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('still resolves docker stop when the forced kill reports an exited process', async () => {
    vi.useFakeTimers();
    const child = new MockChild();
    child.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') throw new Error('already exited');
      return true;
    });
    childProcessMocks.spawn.mockReturnValue(child);
    const { DockerSupervisorServiceManager } = await importPlatform();
    const manager = new DockerSupervisorServiceManager();

    const start = manager.start('bot-a');
    child.emit('spawn');
    await start;

    const stop = manager.stop('bot-a');
    await vi.advanceTimersByTimeAsync(15_000);
    await stop;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills docker instances after the graceful stop timeout and restarts with a new child', async () => {
    vi.useFakeTimers();
    const children: MockChild[] = [];
    childProcessMocks.spawn.mockImplementation(() => {
      const child = new MockChild();
      children.push(child);
      return child;
    });
    const { DockerSupervisorServiceManager } = await importPlatform();
    const manager = new DockerSupervisorServiceManager();

    const start = manager.start('bot-a');
    children[0].emit('spawn');
    await start;

    const stop = manager.stop('bot-a');
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(15_000);
    await stop;
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    children[0].emit('exit');

    const restart = manager.restart('bot-a');
    await Promise.resolve();
    expect(children).toHaveLength(2);
    children[1].emit('spawn');
    await restart;
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
  });
});
