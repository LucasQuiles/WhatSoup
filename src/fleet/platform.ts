/**
 * Cross-platform service manager abstraction.
 *
 * Supports:
 *  - Linux with systemd: systemctl --user
 *  - macOS: launchd via launchctl
 *  - Linux without systemd (WSL1, containers): throws descriptive errors
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export type Platform = 'linux-systemd' | 'macos-launchd' | 'linux-no-systemd';

let _cachedPlatform: Platform | undefined;

/** Detect the service management platform. */
export function detectPlatform(): Platform {
  if (_cachedPlatform !== undefined) return _cachedPlatform;

  if (process.platform === 'darwin') {
    _cachedPlatform = 'macos-launchd';
    return _cachedPlatform;
  }

  if (process.platform === 'linux') {
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
  const wrapper = path.join(os.homedir(), '.local', 'bin', 'whatsoup');
  const envPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';

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

/** Parse a unit-style name: "whatsoup@foo" -> "foo", "whatsoup-fleet" -> "whatsoup-fleet". */
export function parseInstanceName(unit: string): string {
  const match = unit.match(/^whatsoup@(.+)$/);
  return match ? match[1] : unit;
}

// ---- Linux systemd ----

class SystemdServiceManager implements ServiceManager {
  private unit(name: string): string {
    return `whatsoup@${name}`;
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

  startFire(name: string, onError?: (err: Error | null) => void): void {
    execFile('systemctl', ['--user', 'start', this.unit(name)], (err) => {
      if (onError) onError(err);
    });
  }
}

// ---- macOS launchd ----

class LaunchdServiceManager implements ServiceManager {
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

  startFire(name: string, onError?: (err: Error | null) => void): void {
    execFile('launchctl', ['start', launchdLabel(name)], (err) => {
      if (onError) onError(err);
    });
  }
}

// ---- Fallback for Linux without systemd (WSL1, containers) ----

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let _cachedManager: ServiceManager | undefined;

/** Create (or return cached) service manager for the current platform. */
export function createServiceManager(): ServiceManager {
  if (_cachedManager) return _cachedManager;

  const platform = detectPlatform();
  switch (platform) {
    case 'linux-systemd':
      _cachedManager = new SystemdServiceManager();
      break;
    case 'macos-launchd':
      _cachedManager = new LaunchdServiceManager();
      break;
    case 'linux-no-systemd':
      _cachedManager = new NoSystemdServiceManager();
      break;
  }
  return _cachedManager;
}

/** Reset cached state (for testing). */
export function _resetPlatformCache(): void {
  _cachedPlatform = undefined;
  _cachedManager = undefined;
}
