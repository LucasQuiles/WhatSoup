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

/**
 * Path-aware readFileSync fake: render paths read both the installed plist
 * (*.plist) and the instance config (config.json), so route by basename
 * instead of returning one value for every read. Undefined surfaces raise
 * ENOENT like the default absentFile mock.
 */
function mockReads({ plist, config }: { plist?: string; config?: unknown } = {}): void {
  fsMocks.readFileSync.mockImplementation((target: unknown) => {
    const file = String(target);
    if (file.endsWith('.plist') && plist !== undefined) return plist;
    if (file.endsWith('config.json') && config !== undefined) {
      return typeof config === 'string' ? config : JSON.stringify(config);
    }
    absentFile();
  });
}

/**
 * Reads one EnvironmentVariables value back out of a rendered plist. The
 * generated plist puts a KeepAlive dict BEFORE EnvironmentVariables, so the
 * block is anchored on its own key rather than on the first <dict>.
 */
function readPlistEnv(plist: string, key: string): string | undefined {
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)?.[1];
  if (envBlock === undefined) return undefined;
  return new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`).exec(envBlock)?.[1];
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
    mockReads({ plist: generatedPlistIdentity() });
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

  it('renders the configured service block into a first-install plist', async () => {
    setPlatform('darwin');
    mockReads({
      config: {
        name: 'agent',
        service: {
          claudeConfigDir: '/opt/claude-roots/agent',
          pathPrepend: ['/opt/service-bin'],
        },
      },
    });
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();
    if (!manager.startAfterAuthFire) throw new Error('missing macOS authenticated-start hook');

    await new Promise<void>((resolve, reject) => {
      manager.startAfterAuthFire!('agent', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.com.whatsoup.agent.plist.tmp-'),
      expect.stringContaining('<key>CLAUDE_CONFIG_DIR</key>'),
      { encoding: 'utf-8', mode: 0o644 },
    );
    const written = String(fsMocks.writeFileSync.mock.calls[0]?.[1]);
    expect(written).toContain('<string>/opt/claude-roots/agent</string>');
    expect(written).toContain('<string>/opt/service-bin:');
  });

  it('fails a first install closed when the instance service block is invalid', async () => {
    setPlatform('darwin');
    mockReads({ config: { name: 'agent', service: { claudeConfigDir: 'relative/root' } } });
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();
    if (!manager.startAfterAuthFire) throw new Error('missing macOS authenticated-start hook');

    const firstStart = new Promise<void>((resolve, reject) => {
      manager.startAfterAuthFire!('agent', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await expect(firstStart).rejects.toThrow('service.claudeConfigDir');
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('re-renders the resolved service block when reconciling an existing plist', async () => {
    setPlatform('darwin');
    mockReads({
      plist: generatedPlistIdentity(),
      config: { name: 'agent', service: { claudeConfigDir: '/opt/claude-roots/agent' } },
    });
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {})).resolves.toMatchObject({ dryRun: false });

    expect(fsMocks.writeFileSync).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('.com.whatsoup.agent.plist.tmp-'),
      expect.stringContaining('<key>CLAUDE_CONFIG_DIR</key>'),
      { encoding: 'utf-8', mode: 0o644 },
    );
  });

  it('fails reconciliation closed before bootout when the service block is invalid', async () => {
    setPlatform('darwin');
    mockReads({
      plist: generatedPlistIdentity(),
      config: { name: 'agent', service: { pathPrepend: ['relative/bin'] } },
    });
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {})).rejects.toThrow('service.pathPrepend');
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('renders caller-supplied renderOptions without consulting instance config', async () => {
    setPlatform('darwin');
    mockReads({ plist: generatedPlistIdentity(), config: '{ intentionally-not-json' });
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {
      renderOptions: { claudeConfigDir: '/opt/claude-roots/explicit' },
    })).resolves.toMatchObject({ dryRun: false });

    const written = String(fsMocks.writeFileSync.mock.calls[0]?.[1]);
    expect(written).toContain('<string>/opt/claude-roots/explicit</string>');
  });

  it('rejects caller-supplied renderOptions that violate the shared shape rules', async () => {
    setPlatform('darwin');
    mockReads({ plist: generatedPlistIdentity() });
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {
      renderOptions: { claudeConfigDir: 'relative/root' },
    })).rejects.toThrow('service.claudeConfigDir');
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('restores the prior plist bytes, not the new render, when reload fails after an options render', async () => {
    setPlatform('darwin');
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    mockReads({
      plist: generatedPlistIdentity(),
      config: { name: 'agent', service: { claudeConfigDir: '/opt/claude-roots/agent' } },
    });
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

    // First write publishes the options render; the rollback write restores
    // the exact prior bytes, which never contained the claude root.
    const firstWrite = String(fsMocks.writeFileSync.mock.calls[0]?.[1]);
    expect(firstWrite).toContain('<key>CLAUDE_CONFIG_DIR</key>');
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
  });

  it('reports governed-env drift on a dry-run reconcile without touching disk or launchd', async () => {
    setPlatform('darwin');
    const { buildPlist, reconcileLaunchdPlist } = await importPlatform();
    // The installed plist is a real render without the newly configured
    // claude root: reconciliation must flag CLAUDE_CONFIG_DIR as missing.
    const observed = buildPlist('agent');
    mockReads({
      plist: observed,
      config: { name: 'agent', service: { claudeConfigDir: '/opt/claude-roots/agent' } },
    });

    const result = await reconcileLaunchdPlist('agent', { dryRun: true });

    expect(result.governedEnvDrift).toMatchObject({ comparable: true });
    expect(result.governedEnvDrift?.drift).toEqual([{
      key: 'CLAUDE_CONFIG_DIR',
      state: 'missing',
      expectedDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      observedDigest: null,
    }]);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('reports a hand-patched PATH with no config source as a tail difference, by digest only', async () => {
    setPlatform('darwin');
    const { buildPlist, reconcileLaunchdPlist } = await importPlatform();
    // Simulates the hand-patched-plist class this feature adopts BEFORE the
    // prepend is config-owned: nothing is configured, so the PATH prefix is
    // trivially satisfied and only the tail differs from this shell's PATH.
    const observed = buildPlist('agent', { pathPrepend: ['/opt/hand-patched-bin'] });
    mockReads({ plist: observed, config: { name: 'agent' } });

    const result = await reconcileLaunchdPlist('agent', { dryRun: true });

    // WHATSOUP_PATH_PREPEND is a governed key, so an installed value with no
    // config source is reported as governed `extra` drift rather than being
    // invisible. Before it was governed the same hand-added key counted as a
    // non-governed drop and refused --apply; now --apply overwrites it. Value
    // still never leaves the comparator: digest only, asserted below.
    expect(result.governedEnvDrift?.drift).toEqual([{
      key: 'WHATSOUP_PATH_PREPEND',
      state: 'extra',
      expectedDigest: null,
      observedDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    }]);
    expect(result.governedEnvDrift?.pathPrefix).toEqual({
      configured: false,
      satisfied: true,
      ambientTailDiffers: true,
      expectedDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      observedDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(result.governedEnvDrift)).not.toContain('hand-patched');
  });

  it('reports a governed PATH mismatch when the installed PATH lacks the configured prefix', async () => {
    setPlatform('darwin');
    const { buildPlist, reconcileLaunchdPlist } = await importPlatform();
    const observed = buildPlist('agent', { pathPrepend: ['/opt/hand-patched-bin'] });
    mockReads({ plist: observed, config: { name: 'agent', service: { pathPrepend: ['/opt/service-bin'] } } });

    const result = await reconcileLaunchdPlist('agent', { dryRun: true });

    // Both governed surfaces disagree: the composed PATH and the governed
    // prepend key that now carries the same config fact on its own.
    expect(result.governedEnvDrift?.drift.map((entry) => `${entry.key}:${entry.state}`))
      .toEqual(['PATH:mismatch', 'WHATSOUP_PATH_PREPEND:mismatch']);
    expect(result.governedEnvDrift?.pathPrefix).toMatchObject({ configured: true, satisfied: false });
  });

  it('renders the governed PATH prepend as its own environment key without changing PATH composition', async () => {
    setPlatform('darwin');
    const previousPath = process.env.PATH;
    // env-allowed in test: buildPlist reads the generating shell's PATH as the
    // ambient tail, so it has to be pinned for an exact-equality assertion.
    process.env.PATH = '/loaded/bin';
    try {
      const { buildPlist } = await importPlatform();
      const rendered = buildPlist('agent', { pathPrepend: ['/fixture/pin/bin', '/fixture/second/bin'] });

      expect(rendered).toContain('    <key>WHATSOUP_PATH_PREPEND</key>');
      expect(readPlistEnv(rendered, 'WHATSOUP_PATH_PREPEND')).toBe('/fixture/pin/bin:/fixture/second/bin');
      // PATH composition is untouched: still `prepend:ambient`.
      expect(readPlistEnv(rendered, 'PATH')).toBe('/fixture/pin/bin:/fixture/second/bin:/loaded/bin');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('renders both governed PATH surfaces from one config fact', async () => {
    setPlatform('darwin');
    const previousPath = process.env.PATH;
    const previousNode = process.env.WHATSOUP_NODE;
    process.env.PATH = '/loaded/bin';
    process.env.WHATSOUP_NODE = '/fixture/node/bin/node';
    try {
      const { buildPlist } = await importPlatform();
      const rendered = buildPlist('agent', { pathPrepend: ['/fixture/pin/bin'] });
      const servicePath = readPlistEnv(rendered, 'PATH');
      const governedPrepend = readPlistEnv(rendered, 'WHATSOUP_PATH_PREPEND');

      // These two are what the renderer actually decides, and they are what made
      // this test red on base. launchd injects both, and deploy/lib/runtime-path.sh
      // composes "$prepend:$home/.local/bin:$node_dir:$inherited", so the governed
      // prepend appears TWICE in the effective PATH and first match wins. That
      // composition is proven executably in
      // deploy/scripts/tests/test_runtime_path_prepend.sh, which runs the real
      // helper; node:child_process is mocked here, so re-joining the pieces in
      // this file would only assert a literal against itself.
      expect(servicePath).toBe('/fixture/pin/bin:/loaded/bin');
      expect(governedPrepend).toBe('/fixture/pin/bin');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousNode === undefined) delete process.env.WHATSOUP_NODE;
      else process.env.WHATSOUP_NODE = previousNode;
    }
  });

  it('renders byte-identical output when no path prepend is configured', async () => {
    setPlatform('darwin');
    const { buildPlist } = await importPlatform();
    const baseline = buildPlist('agent');

    expect(baseline).not.toContain('WHATSOUP_PATH_PREPEND');
    expect(buildPlist('agent', {})).toBe(baseline);
    expect(buildPlist('agent', { pathPrepend: [] })).toBe(baseline);
  });

  it('refuses an apply that would drop installed non-governed keys unless the drop is acknowledged', async () => {
    setPlatform('darwin');
    const { LaunchdReconcileRefusedError, buildPlist, reconcileLaunchdPlist } = await importPlatform();
    const observed = buildPlist('agent').replace(
      '    <key>HOME</key>',
      '    <key>WHATSOUP_HEALTH_TOKEN</key>\n    <string>sentinel-token-value-never-reported</string>\n    <key>HOME</key>',
    );
    mockReads({ plist: observed, config: { name: 'agent' } });

    let thrown: unknown;
    try {
      await reconcileLaunchdPlist('agent', { dryRun: false });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LaunchdReconcileRefusedError);
    expect((thrown as Error).message).toContain('WHATSOUP_HEALTH_TOKEN');
    expect((thrown as Error).message).not.toContain('never-reported');
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('proceeds with the apply when the non-governed drop is explicitly acknowledged', async () => {
    setPlatform('darwin');
    const { buildPlist, reconcileLaunchdPlist } = await importPlatform();
    const observed = buildPlist('agent').replace(
      '    <key>HOME</key>',
      '    <key>WHATSOUP_HEALTH_TOKEN</key>\n    <string>sentinel-token-value-never-reported</string>\n    <key>HOME</key>',
    );
    mockReads({ plist: observed, config: { name: 'agent' } });

    await expect(reconcileLaunchdPlist('agent', { dryRun: false, dropNonGovernedEnv: true }))
      .resolves.toMatchObject({ dryRun: false });

    expect(fsMocks.writeFileSync).toHaveBeenCalled();
    const domain = `gui/${currentUid()}`;
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
  });

  it('proceeds with an apply whose only drift is a governed hand-added PATH prepend', async () => {
    setPlatform('darwin');
    const { buildPlist, reconcileLaunchdPlist } = await importPlatform();
    // Before the key was governed this same plist refused --apply as a
    // non-governed drop. Governing it means --apply now OVERWRITES an
    // operator's hand-set value. That is the disclosed live behaviour change,
    // and it needs a positive assertion, not just an empty droppedNonGovernedKeys.
    const observed = buildPlist('agent').replace(
      '    <key>HOME</key>',
      '    <key>WHATSOUP_PATH_PREPEND</key>\n    <string>/opt/hand-added-bin</string>\n    <key>HOME</key>',
    );
    mockReads({ plist: observed, config: { name: 'agent' } });

    await expect(reconcileLaunchdPlist('agent', { dryRun: false }))
      .resolves.toMatchObject({ dryRun: false });

    expect(fsMocks.writeFileSync).toHaveBeenCalled();
    const written = String(fsMocks.writeFileSync.mock.calls[0]?.[1]);
    expect(written).not.toContain('hand-added-bin');
    const domain = `gui/${currentUid()}`;
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
  });

  it('refuses an apply when the installed EnvironmentVariables dict is unparseable, unless acknowledged', async () => {
    setPlatform('darwin');
    const { LaunchdReconcileRefusedError, reconcileLaunchdPlist } = await importPlatform();
    const observed = `${generatedPlistIdentity()}\n<key>EnvironmentVariables</key>\n<dict>\n<key>PATH</key>`;
    mockReads({ plist: observed, config: { name: 'agent' } });

    await expect(reconcileLaunchdPlist('agent', { dryRun: false })).rejects.toThrow(LaunchdReconcileRefusedError);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('reports installed non-governed key names that an apply would drop', async () => {
    setPlatform('darwin');
    const { buildPlist, reconcileLaunchdPlist } = await importPlatform();
    const observed = buildPlist('agent').replace(
      '    <key>HOME</key>',
      '    <key>WHATSOUP_HEALTH_TOKEN</key>\n    <string>sentinel-token-value-never-reported</string>\n    <key>HOME</key>',
    );
    mockReads({ plist: observed, config: { name: 'agent' } });

    const result = await reconcileLaunchdPlist('agent', { dryRun: true });

    expect(result.governedEnvDrift?.droppedNonGovernedKeys).toEqual(['WHATSOUP_HEALTH_TOKEN']);
    expect(JSON.stringify(result.governedEnvDrift)).not.toContain('never-reported');
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

  it('retries a transient launchd bootstrap I/O error after bootout settles', async () => {
    vi.useFakeTimers();
    setPlatform('darwin');
    mockReads({ plist: generatedPlistIdentity() });
    childProcessMocks.execFile
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(null, '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        const error = Object.assign(new Error('Bootstrap failed: 5: Input/output error'), {
          code: 5,
          stderr: 'Bootstrap failed: 5: Input/output error',
        });
        queueMicrotask(() => callback?.(error, '', error.stderr));
        return new EventEmitter();
      })
      .mockImplementation((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(null, '', ''));
        return new EventEmitter();
      });
    const { reconcileLaunchdPlist } = await importPlatform();

    const reconciliation = reconcileLaunchdPlist('agent', {});
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(reconciliation).resolves.toMatchObject({
      label: 'com.whatsoup.agent',
      dryRun: false,
    });
    const domain = `gui/${currentUid()}`;
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['bootout', `${domain}/com.whatsoup.agent`], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(2, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(3, 'launchctl', ['bootstrap', domain, plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(4, 'launchctl', ['kickstart', '-k', `${domain}/com.whatsoup.agent`], expect.any(Function));
  });

  it('restores the prior plist and job when launchd reload fails', async () => {
    setPlatform('darwin');
    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    mockReads({ plist: generatedPlistIdentity() });
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
    mockReads({ plist: generatedPlistIdentity() });
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
    mockReads({ plist: generatedPlistIdentity() });
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
    mockReads({ plist: generatedPlistIdentity() });
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
