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
    fsMocks.writeFileSync.mockReset();
    fsMocks.unlinkSync.mockReset();
    osMocks.homedir.mockReset();

    fsMocks.existsSync.mockReturnValue(false);
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

  it('writes, loads, unloads, and removes launchd plists on macOS', async () => {
    setPlatform('darwin');
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();

    await manager.enable('agent');
    await manager.start('agent');
    await manager.stop('agent');
    await manager.restart('agent');
    await manager.disable('agent');

    const plist = '/tmp/whatsoup-home/Library/LaunchAgents/com.whatsoup.agent.plist';
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/tmp/whatsoup-home/Library/LaunchAgents', { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      plist,
      expect.stringContaining('<string>com.whatsoup.agent</string>'),
      'utf-8',
    );
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(plist);
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['load', plist], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(2, 'launchctl', ['start', 'com.whatsoup.agent'], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(3, 'launchctl', ['stop', 'com.whatsoup.agent'], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(4, 'launchctl', ['stop', 'com.whatsoup.agent'], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(5, 'launchctl', ['start', 'com.whatsoup.agent'], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(6, 'launchctl', ['unload', plist], expect.any(Function));
  });

  it('continues launchd disable when unload and unlink report already-absent state', async () => {
    setPlatform('darwin');
    childProcessMocks.execFile.mockImplementation((_cmd, _args, optionsOrCallback, maybeCallback) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      queueMicrotask(() => callback?.(new Error('not loaded'), '', ''));
      return new EventEmitter();
    });
    fsMocks.unlinkSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().disable('missing')).resolves.toBeUndefined();
  });

  it('continues launchd restart when stop reports an already-stopped service', async () => {
    setPlatform('darwin');
    childProcessMocks.execFile
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(new Error('not running'), '', ''));
        return new EventEmitter();
      })
      .mockImplementationOnce((_cmd, _args, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        queueMicrotask(() => callback?.(null, '', ''));
        return new EventEmitter();
      });
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().restart('agent')).resolves.toBeUndefined();
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(1, 'launchctl', ['stop', 'com.whatsoup.agent'], expect.any(Function));
    expect(childProcessMocks.execFile).toHaveBeenNthCalledWith(2, 'launchctl', ['start', 'com.whatsoup.agent'], expect.any(Function));
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

  it('clears a failed docker spawn so a retry creates a fresh child', async () => {
    const children: MockChild[] = [];
    childProcessMocks.spawn.mockImplementation(() => {
      const child = new MockChild();
      children.push(child);
      return child;
    });
    const { DockerSupervisorServiceManager } = await importPlatform();
    const manager = new DockerSupervisorServiceManager();

    const failedStart = manager.start('bot-a');
    children[0].emit('error', new Error('spawn denied'));
    await expect(failedStart).rejects.toThrow('spawn denied');

    const retry = manager.start('bot-a');
    expect(children).toHaveLength(2);
    children[1].emit('spawn');
    await expect(retry).resolves.toBeUndefined();
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
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
