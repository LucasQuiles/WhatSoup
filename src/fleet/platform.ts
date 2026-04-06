/**
 * Cross-platform service manager.
 * Uses launchctl (launchd) on macOS, systemctl (systemd) on Linux.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

const execFileAsync = promisify(execFile);
const IS_MACOS = process.platform === 'darwin';

function label(name: string): string {
  return `com.whatsoup.${name}`;
}

function plistPath(name: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label(name)}.plist`);
}

function buildPlist(name: string): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  const logDir = path.join(xdgConfig, 'whatsoup', 'instances', name);
  const wrapper = path.join(os.homedir(), '.local', 'bin', 'whatsoup');
  const envPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${label(name)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array><string>${wrapper}</string><string>${name}</string></array>`,
    `  <key>RunAtLoad</key><false/>`,
    `  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>`,
    `  <key>StandardOutPath</key><string>${logDir}/stdout.log</string>`,
    `  <key>StandardErrorPath</key><string>${logDir}/stderr.log</string>`,
    `  <key>EnvironmentVariables</key><dict>`,
    `    <key>PATH</key><string>${envPath}</string>`,
    `    <key>HOME</key><string>${os.homedir()}</string>`,
    `  </dict>`,
    `</dict></plist>`,
  ].join('\n');
}

/** Register service so it can be started. Does not start it. */
export async function enableService(name: string): Promise<void> {
  if (!IS_MACOS) {
    await execFileAsync('systemctl', ['--user', 'enable', `whatsoup@${name}`]);
    return;
  }
  const dest = plistPath(name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buildPlist(name), 'utf-8');
  await execFileAsync('launchctl', ['load', dest]);
}

/** Start a registered service. */
export async function startService(name: string): Promise<void> {
  if (!IS_MACOS) {
    await execFileAsync('systemctl', ['--user', 'start', `whatsoup@${name}`]);
    return;
  }
  await execFileAsync('launchctl', ['start', label(name)]);
}

/** Stop a running service. */
export async function stopService(name: string): Promise<void> {
  if (!IS_MACOS) {
    await execFileAsync('systemctl', ['--user', 'stop', `whatsoup@${name}`]);
    return;
  }
  await execFileAsync('launchctl', ['stop', label(name)]);
}

/** Stop, unregister, and remove service definition. */
export async function disableService(name: string): Promise<void> {
  if (!IS_MACOS) {
    await execFileAsync('systemctl', ['--user', 'disable', `whatsoup@${name}`]);
    return;
  }
  const dest = plistPath(name);
  try { await execFileAsync('launchctl', ['unload', dest]); } catch { /* ok if not loaded */ }
  try { fs.unlinkSync(dest); } catch { /* ok if not present */ }
}

/** Stop then start a service. */
export async function restartService(name: string): Promise<void> {
  if (!IS_MACOS) {
    await execFileAsync('systemctl', ['--user', 'restart', `whatsoup@${name}`]);
    return;
  }
  try { await stopService(name); } catch { /* ok if not running */ }
  await startService(name);
}

/** Fire-and-forget start with a callback (for post-auth use). */
export function startServiceFire(name: string, cb: (err: Error | null) => void): void {
  if (!IS_MACOS) {
    execFile('systemctl', ['--user', 'start', `whatsoup@${name}`], (err) => cb(err));
    return;
  }
  execFile('launchctl', ['start', label(name)], (err) => cb(err));
}
