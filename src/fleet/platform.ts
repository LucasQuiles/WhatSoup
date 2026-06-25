/**
 * Cross-platform service manager abstraction.
 *
 * Supports:
 *  - Docker containers: in-process child spawning (supervisor mode)
 *  - Linux with systemd: systemctl --user
 *  - macOS: launchd via launchctl
 *  - Linux without systemd (WSL1): throws descriptive errors
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { repoRoot, tmpRoot } from './paths.ts';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export type Platform = 'docker' | 'linux-systemd' | 'macos-launchd' | 'linux-no-systemd';

/** Env var name set by the Dockerfile and docker-compose.yml to signal the container runtime. */
const WHATSOUP_DOCKER_ENV = 'WHATSOUP_DOCKER';

let _cachedPlatform: Platform | undefined;

/** Detect the service management platform. */
export function detectPlatform(): Platform {
  if (_cachedPlatform !== undefined) return _cachedPlatform;

  // Docker detection — env var takes priority over all OS-specific checks
  if (process.env[WHATSOUP_DOCKER_ENV] === '1') {
    _cachedPlatform = 'docker';
    return _cachedPlatform;
  }

  if (process.platform === 'darwin') {
    _cachedPlatform = 'macos-launchd';
    return _cachedPlatform;
  }

  if (process.platform === 'linux') {
    // /.dockerenv fallback for containers that set the sentinel file but not the env var
    if (fs.existsSync('/.dockerenv')) {
      _cachedPlatform = 'docker';
      return _cachedPlatform;
    }

    try {
      execFileSync('systemctl', ['--user', 'show-environment'], {
        timeout: 3_000,
        stdio: 'ignore',
      });
      _cachedPlatform = 'linux-systemd';
    } catch {
      _cachedPlatform = 'linux-no-systemd';
    }
    return _cachedPlatform;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

// ---------------------------------------------------------------------------
// XML helpers (for plist generation)
// ---------------------------------------------------------------------------

/** Escape a string for safe insertion into XML text content or attributes. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// macOS launchd helpers
// ---------------------------------------------------------------------------

function launchdLabel(name: string): string {
  return `com.whatsoup.${name}`;
}

function plistPath(name: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchdLabel(name)}.plist`);
}

/**
 * Build a launchd plist for a WhatSoup instance.
 *
 * All interpolated values are XML-escaped to prevent injection via
 * PATH, home directory, or other environment-sourced strings.
 */
export function buildPlist(name: string): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  const logDir = path.join(xdgConfig, 'whatsoup', 'instances', name);
  const tmpDir = tmpRoot(name);
  const wrapper = path.join(os.homedir(), '.local', 'bin', 'whatsoup');
  const envPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const whatsoupNode = process.env.WHATSOUP_NODE;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(launchdLabel(name))}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXml(wrapper)}</string>`,
    `    <string>${escapeXml(name)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>Crashed</key>',
    '    <true/>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(logDir)}/stdout.log</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(logDir)}/stderr.log</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${escapeXml(envPath)}</string>`,
    '    <key>HOME</key>',
    `    <string>${escapeXml(os.homedir())}</string>`,
    '    <key>TMPDIR</key>',
    `    <string>${escapeXml(tmpDir)}</string>`,
    ...(whatsoupNode
      ? [
          '    <key>WHATSOUP_NODE</key>',
          `    <string>${escapeXml(whatsoupNode)}</string>`,
        ]
      : []),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// ServiceManager interface + implementations
// ---------------------------------------------------------------------------

export interface ServiceManager {
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  /** Fire-and-forget start with optional error callback (used in auth flow). */
  startFire(name: string, onError?: (err: Error | null) => void): void;
}

export function systemdUnitName(name: string): string {
  return name === 'whatsoup-fleet' ? 'whatsoup-fleet.service' : `whatsoup@${name}.service`;
}

/**
 * Base class providing a default `startFire` implementation that delegates to `start()`.
 * Subclasses with async start semantics inherit this default; NoSystemdServiceManager
 * keeps its own startFire override to preserve fail-fast behavior.
 */
abstract class BaseServiceManager implements ServiceManager {
  abstract enable(name: string): Promise<void>;
  abstract disable(name: string): Promise<void>;
  abstract start(name: string): Promise<void>;
  abstract stop(name: string): Promise<void>;
  abstract restart(name: string): Promise<void>;

  startFire(name: string, onError?: (err: Error | null) => void): void {
    this.start(name).then(
      () => { if (onError) onError(null); },
      (err) => { if (onError) onError(err instanceof Error ? err : new Error(String(err))); },
    );
  }
}

// ---- Linux systemd ----

class SystemdServiceManager extends BaseServiceManager {
  private unit(name: string): string {
    return systemdUnitName(name);
  }

  async enable(name: string): Promise<void> {
    await execFileAsync('systemctl', ['--user', 'enable', this.unit(name)]);
  }

  async disable(name: string): Promise<void> {
    await execFileAsync('systemctl', ['--user', 'disable', this.unit(name)]);
  }

  async start(name: string): Promise<void> {
    await execFileAsync('systemctl', ['--user', 'start', this.unit(name)]);
  }

  async stop(name: string): Promise<void> {
    await execFileAsync('systemctl', ['--user', 'stop', this.unit(name)]);
  }

  async restart(name: string): Promise<void> {
    await execFileAsync('systemctl', ['--user', 'restart', this.unit(name)]);
  }
}

// ---- macOS launchd ----

class LaunchdServiceManager extends BaseServiceManager {
  async enable(name: string): Promise<void> {
    const dest = plistPath(name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buildPlist(name), 'utf-8');
    await execFileAsync('launchctl', ['load', dest]);
  }

  async disable(name: string): Promise<void> {
    const dest = plistPath(name);
    try { await execFileAsync('launchctl', ['unload', dest]); } catch { /* ok if not loaded */ }
    try { fs.unlinkSync(dest); } catch { /* ok if not present */ }
  }

  async start(name: string): Promise<void> {
    await execFileAsync('launchctl', ['start', launchdLabel(name)]);
  }

  async stop(name: string): Promise<void> {
    await execFileAsync('launchctl', ['stop', launchdLabel(name)]);
  }

  async restart(name: string): Promise<void> {
    try { await this.stop(name); } catch { /* ok if not running */ }
    await this.start(name);
  }
}

// ---- Fallback for Linux without systemd (WSL1, containers) ----

// Does NOT extend BaseServiceManager: the base's default startFire would
// produce an unhandled rejection when this.start() throws. Keeping a sync
// throw preserves fail-fast semantics for callsites that invoke startFire
// without an onError callback.
class NoSystemdServiceManager implements ServiceManager {
  private fail(): never {
    throw new Error(
      'Service management requires systemd. If running under WSL, enable systemd:\n' +
      '  1. Add "[boot]\\nsystemd=true" to /etc/wsl.conf\n' +
      '  2. Restart WSL: wsl --shutdown\n' +
      'Alternatively, run instances directly: node src/bootstrap.ts <name>',
    );
  }

  async enable(): Promise<void> { this.fail(); }
  async disable(): Promise<void> { this.fail(); }
  async start(): Promise<void> { this.fail(); }
  async stop(): Promise<void> { this.fail(); }
  async restart(): Promise<void> { this.fail(); }
  startFire(): void { this.fail(); }
}

// ---- Docker supervisor (in-process child spawning) ----

export class DockerSupervisorServiceManager extends BaseServiceManager {
  private processes = new Map<string, ChildProcess>();

  async enable(): Promise<void> { /* no-op in Docker */ }
  async disable(): Promise<void> { /* no-op in Docker */ }

  // Called by the fleet auth flow after a successful QR handshake (see routes/ops.ts handleAuth).
  async start(name: string): Promise<void> {
    if (this.processes.has(name)) return; // already running

    // Resolve bootstrap script against the repo root, not `process.cwd()`.
    // Under systemd the unit ships with no `WorkingDirectory=`, so cwd is
    // the service user's `$HOME` and a relative script path ENOENTs (#419).
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      path.join(repoRoot, 'src', 'bootstrap.ts'),
      name,
    ], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    this.processes.set(name, child);
    child.on('exit', () => this.processes.delete(name));

    await new Promise<void>((resolve, reject) => {
      child.on('spawn', resolve);
      child.on('error', reject);
    });
  }

  async stop(name: string): Promise<void> {
    const child = this.processes.get(name);
    if (!child) return;

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        resolve();
      }, 15_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  async restart(name: string): Promise<void> {
    await this.stop(name);
    await this.start(name);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let _cachedManager: ServiceManager | undefined;

/** Create (or return cached) service manager for the current platform. */
export function createServiceManager(): ServiceManager {
  if (_cachedManager) return _cachedManager;

  const platform = detectPlatform();
  switch (platform) {
    case 'docker':
      _cachedManager = new DockerSupervisorServiceManager();
      break;
    case 'linux-systemd':
      _cachedManager = new SystemdServiceManager();
      break;
    case 'macos-launchd':
      _cachedManager = new LaunchdServiceManager();
      break;
    case 'linux-no-systemd':
      _cachedManager = new NoSystemdServiceManager();
      break;
    default: {
      const _exhaustive: never = platform;
      throw new Error(`Unknown platform: ${_exhaustive}`);
    }
  }
  return _cachedManager;
}

/** Reset cached state (for testing). */
export function _resetPlatformCache(): void {
  _cachedPlatform = undefined;
  _cachedManager = undefined;
}
