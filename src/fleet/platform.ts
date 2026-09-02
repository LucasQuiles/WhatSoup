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
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { isValidInstanceName } from './instance-name.ts';
import { escapeRegExp } from '../lib/regex-utils.ts';
import {
  assertValidLaunchdPlistRenderOptions,
  type LaunchdPlistRenderOptions,
} from '../lib/launchd-service-config.ts';
import { resolveLaunchdPlistRenderOptions } from './launchd-render-options.ts';
import { compareGovernedLaunchdEnv, type GovernedEnvComparison } from './launchd-env-drift.ts';
import { repoRoot, tmpRoot, xdgDir } from './paths.ts';
import { SIGNAL } from '../lib/signals.ts';

const execFileAsync = promisify(execFile);
const LAUNCHD_BOOTSTRAP_RETRY_LIMIT = 10;
const LAUNCHD_BOOTSTRAP_RETRY_DELAY_MS = 1_000;

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
  // env-allowed: host-level generating-shell platform detection; pre-instance by design
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

function launchdDomain(): string {
  if (typeof process.getuid !== 'function') {
    throw new Error('launchd service management requires a POSIX user id');
  }
  return `gui/${process.getuid()}`;
}

function launchdServiceTarget(name: string): string {
  return `${launchdDomain()}/${launchdLabel(name)}`;
}

async function bootoutLaunchdService(name: string): Promise<void> {
  await execFileAsync('launchctl', ['bootout', launchdServiceTarget(name)]);
}

function assertValidLaunchdInstanceName(name: string): void {
  if (!isValidInstanceName(name)) throw new Error('invalid instance name');
}

/** Recognize the stable structural fields emitted by WhatSoup's plist generator. */
function isExpectedGeneratedLaunchdPlist(name: string, contents: string): boolean {
  const label = escapeRegExp(escapeXml(launchdLabel(name)));
  const wrapper = escapeRegExp(escapeXml(path.join(os.homedir(), '.local', 'bin', 'whatsoup')));
  const instance = escapeRegExp(escapeXml(name));
  const identity = new RegExp(
    `<key>Label</key>\\s*<string>${label}</string>\\s*` +
    `<key>ProgramArguments</key>\\s*<array>\\s*` +
    `<string>${wrapper}</string>\\s*<string>${instance}</string>`,
    'u',
  );
  return identity.test(contents);
}

function assertExpectedGeneratedLaunchdPlist(name: string, contents: string): void {
  if (!isExpectedGeneratedLaunchdPlist(name, contents)) {
    throw new Error(`launchd plist for ${launchdLabel(name)} does not match the generated WhatSoup instance identity`);
  }
}

/**
 * Build a launchd plist for a WhatSoup instance.
 *
 * All interpolated values are XML-escaped to prevent injection via
 * PATH, home directory, or other environment-sourced strings.
 *
 * `renderOptions` is the typed instance-specific render input; callers resolve
 * it from validated instance config (src/fleet/launchd-render-options.ts) —
 * this function never reads config.json itself. Omitted options render
 * byte-identical output to the historical no-options form.
 */
export function buildPlist(name: string, renderOptions: LaunchdPlistRenderOptions = {}): string {
  assertValidLaunchdInstanceName(name);
  const xdgConfig = xdgDir('XDG_CONFIG_HOME', '.config');
  const logDir = path.join(xdgConfig, 'whatsoup', 'instances', name);
  const tmpDir = tmpRoot(name);
  const wrapper = path.join(os.homedir(), '.local', 'bin', 'whatsoup');
  // env-allowed: ambient OS PATH contract for executable resolution
  const envPath = process.env.PATH ?? (process.platform === 'darwin'
  ? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
  : '/usr/local/bin:/usr/bin:/bin');
  const servicePath = [...(renderOptions.pathPrepend ?? []), envPath].join(':');
  // The launcher composes its effective PATH from an already-joined string and
  // cannot tell a governed prefix from an ambient entry, so the governed prepend
  // is rendered a second time under its own key. Gated on the JOINED value being
  // non-empty: launchctl drops empty-valued keys, so an empty rendered value
  // would read back as absent and report as permanent drift.
  const governedPathPrepend = (renderOptions.pathPrepend ?? []).join(':');
  // env-allowed: host-level generating-shell platform detection; pre-instance by design
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
    // The process deliberately exits 1 on reconnect-exhaustion and
    // unhandledRejection (systemd Restart=on-failure semantics). Crashed:true
    // alone only relaunches on signal deaths, stranding instances on any
    // clean exit(1) (#2682, 21h production outage). SuccessfulExit:false adds
    // relaunch on every non-zero exit — the combined form is the documented
    // bot-plist standard (docs/runbooks/macos-host-setup.md); ThrottleInterval
    // bounds crash loops (same contract as install-bot-errors-sentinel.sh).
    '    <key>Crashed</key>',
    '    <true/>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>60</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(logDir)}/stdout.log</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(logDir)}/stderr.log</string>`,
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXml(repoRoot)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${escapeXml(servicePath)}</string>`,
    '    <key>HOME</key>',
    `    <string>${escapeXml(os.homedir())}</string>`,
    '    <key>TMPDIR</key>',
    `    <string>${escapeXml(tmpDir)}</string>`,
    ...(renderOptions.claudeConfigDir
      ? [
          '    <key>CLAUDE_CONFIG_DIR</key>',
          `    <string>${escapeXml(renderOptions.claudeConfigDir)}</string>`,
        ]
      : []),
    ...(whatsoupNode
      ? [
          '    <key>WHATSOUP_NODE</key>',
          `    <string>${escapeXml(whatsoupNode)}</string>`,
        ]
      : []),
    ...(governedPathPrepend
      ? [
          '    <key>WHATSOUP_PATH_PREPEND</key>',
          `    <string>${escapeXml(governedPathPrepend)}</string>`,
        ]
      : []),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export interface LaunchdReconcileOptions {
  /** Inspect the current plist and report the target without changing disk or launchd. */
  dryRun?: boolean;
  /**
   * Pre-resolved render options. When omitted, the instance's validated
   * `service` config block is resolved via resolveLaunchdPlistRenderOptions —
   * every render path goes through one resolution choke point so a configured
   * governed environment cannot be silently dropped.
   */
  renderOptions?: LaunchdPlistRenderOptions;
  /**
   * Acknowledge that applying may delete installed non-governed
   * EnvironmentVariables keys (or an unparseable dict whose keys cannot be
   * enumerated). Without it, an apply that would do so is refused before any
   * mutation. Ignored on dry runs.
   */
  dropNonGovernedEnv?: boolean;
}

/**
 * Thrown before any mutation when an apply would delete installed
 * EnvironmentVariables keys the render does not own (credential keys live
 * there on the fleet) and the caller has not acknowledged the drop. The
 * message carries key NAMES only and is safe to print verbatim.
 */
export class LaunchdReconcileRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchdReconcileRefusedError';
  }
}

export interface LaunchdReconcileResult {
  label: string;
  plistPath: string;
  priorPlistExisted: boolean;
  dryRun: boolean;
  /**
   * Governed-environment comparison between the fresh render and the
   * previously installed plist (CLAUDE_CONFIG_DIR, PATH — by key and value
   * digest, never values). Set on every successful reconcile, dry-run
   * included.
   */
  governedEnvDrift?: GovernedEnvComparison;
}

function readExistingLaunchdPlist(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Read an existing plist only when it still bears the generated identity we own. */
function readExpectedGeneratedLaunchdPlist(name: string, filePath: string): string | null {
  const contents = readExistingLaunchdPlist(filePath);
  if (contents !== null) assertExpectedGeneratedLaunchdPlist(name, contents);
  return contents;
}

/** Publish a complete launchd plist in one same-directory rename. */
function writeAtomicLaunchdPlist(filePath: string, contents: string): void {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryExists = false;
  try {
    // launchd rejects job definitions that are group- or world-writable. A
    // same-directory rename replaces the old inode, so make the new inode safe
    // independently of a permissive user umask.
    temporaryExists = true;
    fs.writeFileSync(temporaryPath, contents, { encoding: 'utf-8', mode: 0o644 });
    fs.renameSync(temporaryPath, filePath);
    temporaryExists = false;
  } catch (error) {
    if (temporaryExists) {
      try { fs.unlinkSync(temporaryPath); } catch {
        /* intentional: optional temporary-file cleanup must not replace the primary atomic-write failure */
      }
    }
    throw error;
  }
}

function restoreLaunchdPlist(filePath: string, previousContents: string | null): void {
  if (previousContents !== null) {
    writeAtomicLaunchdPlist(filePath, previousContents);
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function rollbackFailure(original: unknown, rollbacks: readonly unknown[]): Error {
  const originalMessage = original instanceof Error ? original.message : String(original);
  const rollbackMessage = rollbacks
    .map((rollback) => rollback instanceof Error ? rollback.message : String(rollback))
    .join('; ');
  return new Error(`launchd reload failed: ${originalMessage}; rollback also failed: ${rollbackMessage}`);
}

function isTransientLaunchdBootstrapError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; stderr?: unknown };
  if (candidate.code === 5 || candidate.code === '5') return true;
  const detail = [candidate.message, candidate.stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return /Bootstrap failed:\s*5:\s*Input\/output error/u.test(detail);
}

async function waitForLaunchdBootstrapRetry(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, LAUNCHD_BOOTSTRAP_RETRY_DELAY_MS);
  });
}

async function bootstrapLaunchdJobWithRetry(domain: string, dest: string): Promise<void> {
  for (let attempt = 1; attempt <= LAUNCHD_BOOTSTRAP_RETRY_LIMIT; attempt += 1) {
    try {
      await execFileAsync('launchctl', ['bootstrap', domain, dest]);
      return;
    } catch (error) {
      if (attempt === LAUNCHD_BOOTSTRAP_RETRY_LIMIT || !isTransientLaunchdBootstrapError(error)) {
        throw error;
      }
      await waitForLaunchdBootstrapRetry();
    }
  }
}

async function bootstrapLaunchdService(name: string, dest: string): Promise<void> {
  const domain = launchdDomain();
  await bootstrapLaunchdJobWithRetry(domain, dest);
  await execFileAsync('launchctl', ['kickstart', '-k', launchdServiceTarget(name)]);
}

/** Attempt every rollback step so one failed cleanup cannot strand new bytes. */
async function rollbackLaunchdService(
  name: string,
  dest: string,
  previousContents: string | null,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    await bootoutLaunchdService(name);
  } catch (error) {
    if (!isLaunchdAbsentServiceError(error)) failures.push(error);
  }

  let restored = false;
  try {
    restoreLaunchdPlist(dest, previousContents);
    restored = true;
  } catch (error) {
    failures.push(error);
  }

  if (restored && previousContents !== null) {
    try {
      await bootstrapLaunchdService(name, dest);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function throwLaunchdFailure(original: unknown, rollbackFailures: readonly unknown[]): never {
  if (rollbackFailures.length > 0) throw rollbackFailure(original, rollbackFailures);
  throw original;
}

/**
 * Applying regenerates the whole plist, so every installed key the render
 * does not own disappears from the job. Refuse — before any mutation — unless
 * the caller acknowledged the drop; an unparseable installed dict is refused
 * the same way because its keys cannot be enumerated.
 */
function refuseApplyThatDropsEnv(comparison: GovernedEnvComparison): void {
  if (!comparison.comparable) {
    throw new LaunchdReconcileRefusedError(
      'installed plist has an unparseable EnvironmentVariables dict, so --apply cannot prove it drops no non-governed keys; pass --drop-non-governed-env to acknowledge',
    );
  }
  const dropped = comparison.droppedNonGovernedKeys;
  if (dropped.length === 0) return;
  throw new LaunchdReconcileRefusedError(
    `installed plist has ${dropped.length} non-governed EnvironmentVariables keys (${dropped.join(', ')}) that --apply will drop; pass --drop-non-governed-env to acknowledge`,
  );
}

/**
 * Re-render and reload an existing macOS instance plist.
 *
 * A failed bootout is deliberately terminal rather than being guessed as an
 * already-unloaded job: a failed launchctl operation may also mean an invalid
 * domain or authorization problem. After bootstrap or kickstart fails, boot
 * out the potentially new job before atomically restoring and restarting the
 * old definition.
 */
export async function reconcileLaunchdPlist(
  name: string,
  options: LaunchdReconcileOptions = {},
): Promise<LaunchdReconcileResult> {
  assertValidLaunchdInstanceName(name);
  if (process.platform !== 'darwin') {
    throw new Error('launchd reconciliation is only available on macOS');
  }
  const dest = plistPath(name);
  const previousContents = readExpectedGeneratedLaunchdPlist(name, dest);
  if (previousContents === null) {
    throw new Error(`no existing launchd plist for ${launchdLabel(name)}`);
  }
  const renderOptions = options.renderOptions ?? resolveLaunchdPlistRenderOptions(name);
  assertValidLaunchdPlistRenderOptions(renderOptions);
  // Render once: the drift report always describes exactly the bytes an apply
  // would install.
  const rendered = buildPlist(name, renderOptions);
  const governedEnvDrift = compareGovernedLaunchdEnv(rendered, previousContents, {
    pathPrepend: renderOptions.pathPrepend,
  });
  const result: LaunchdReconcileResult = {
    label: launchdLabel(name),
    plistPath: dest,
    priorPlistExisted: true,
    dryRun: options.dryRun === true,
    governedEnvDrift,
  };
  if (result.dryRun) return result;
  if (options.dropNonGovernedEnv !== true) refuseApplyThatDropsEnv(governedEnvDrift);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  writeAtomicLaunchdPlist(dest, rendered);

  try {
    await bootoutLaunchdService(name);
  } catch (error) {
    try {
      restoreLaunchdPlist(dest, previousContents);
    } catch (rollback) {
      throwLaunchdFailure(error, [rollback]);
    }
    throw error;
  }

  try {
    await bootstrapLaunchdService(name, dest);
  } catch (error) {
    throwLaunchdFailure(error, await rollbackLaunchdService(name, dest, previousContents));
  }

  return result;
}

/** Install a newly authenticated instance without loading any pre-auth job. */
async function installLaunchdPlist(name: string): Promise<void> {
  // Resolve (and thereby validate) the instance's render options before any
  // filesystem mutation so an invalid service block aborts the install whole.
  const renderOptions = resolveLaunchdPlistRenderOptions(name);
  const dest = plistPath(name);
  const previousContents = readExpectedGeneratedLaunchdPlist(name, dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  writeAtomicLaunchdPlist(dest, buildPlist(name, renderOptions));

  try {
    await bootstrapLaunchdService(name, dest);
  } catch (error) {
    throwLaunchdFailure(error, await rollbackLaunchdService(name, dest, previousContents));
  }
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
  /** Optional auth teardown hook; false means there was no job to restore after a failed pairing. */
  stopForAuth?(name: string): Promise<boolean | void>;
  /** Optional authenticated-only activation hook for platforms that defer installation until pairing succeeds. */
  startAfterAuthFire?(name: string, onError?: (err: Error | null) => void): void;
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

  startAfterAuthFire(name: string, onError?: (err: Error | null) => void): void {
    this.startFire(name, onError);
  }

  stopForAuth(name: string): Promise<boolean | void> {
    return this.stop(name);
  }
}

// ---- Linux systemd ----

class SystemdServiceManager extends BaseServiceManager {
  private unit(name: string): string {
    return systemdUnitName(name);
  }

  async enable(name: string): Promise<void> {
    await execFileAsync('systemctl', ['--user', 'reenable', this.unit(name)]);
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

function isLaunchdAbsentServiceError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 3;
}

class LaunchdServiceManager extends BaseServiceManager {
  /** Jobs explicitly removed by this manager and awaiting a subsequent start. */
  private bootedOutServices = new Set<string>();

  private async bootout(name: string): Promise<boolean> {
    try {
      await bootoutLaunchdService(name);
    } catch (error) {
      if (isLaunchdAbsentServiceError(error)) return false;
      throw error;
    }
    return true;
  }

  private async bootstrapAfterBootout(name: string, dest: string): Promise<void> {
    await bootstrapLaunchdService(name, dest);
    this.bootedOutServices.delete(name);
  }

  private async kickstartExisting(name: string, dest: string, replaceRunning: boolean): Promise<void> {
    const args = replaceRunning
      ? ['kickstart', '-k', launchdServiceTarget(name)]
      : ['kickstart', launchdServiceTarget(name)];
    try {
      await execFileAsync('launchctl', args);
    } catch (error) {
      if (!isLaunchdAbsentServiceError(error)) throw error;
      await this.bootstrapAfterBootout(name, dest);
      return;
    }
    this.bootedOutServices.delete(name);
  }

  async enable(name: string): Promise<void> {
    assertValidLaunchdInstanceName(name);
    // handleCreateLine calls enable before QR authentication. KeepAlive with
    // SuccessfulExit=false implies RunAtLoad, so creating/loading a plist here
    // would race the unauthenticated auth flow. startAfterAuthFire() owns the
    // first installation after the pairing helper has finished successfully.
  }

  async disable(name: string): Promise<void> {
    assertValidLaunchdInstanceName(name);
    const dest = plistPath(name);
    if (readExpectedGeneratedLaunchdPlist(name, dest) === null) return;
    await this.bootout(name);
    try {
      fs.unlinkSync(dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.bootedOutServices.delete(name);
  }

  async start(name: string): Promise<void> {
    assertValidLaunchdInstanceName(name);
    const dest = plistPath(name);
    if (readExpectedGeneratedLaunchdPlist(name, dest) === null) {
      throw new Error('launchd plist is installed only after successful authentication; authenticate the instance before starting');
    }
    if (this.bootedOutServices.has(name)) {
      await this.bootstrapAfterBootout(name, dest);
      return;
    }
    await this.kickstartExisting(name, dest, false);
  }

  startAfterAuthFire(name: string, onError?: (err: Error | null) => void): void {
    try {
      assertValidLaunchdInstanceName(name);
    } catch (error) {
      if (onError) onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let start: Promise<void>;
    try {
      const dest = plistPath(name);
      const existing = readExpectedGeneratedLaunchdPlist(name, dest);
      start = existing === null
        ? installLaunchdPlist(name)
        : this.bootedOutServices.has(name)
          ? this.bootstrapAfterBootout(name, dest)
          : this.kickstartExisting(name, dest, true);
    } catch (error) {
      if (onError) onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    start.then(
      () => {
        this.bootedOutServices.delete(name);
        if (onError) onError(null);
      },
      (err) => { if (onError) onError(err instanceof Error ? err : new Error(String(err))); },
    );
  }

  async stop(name: string): Promise<void> {
    assertValidLaunchdInstanceName(name);
    if (readExpectedGeneratedLaunchdPlist(name, plistPath(name)) === null) return;
    await this.bootout(name);
    this.bootedOutServices.add(name);
  }

  async stopForAuth(name: string): Promise<boolean> {
    assertValidLaunchdInstanceName(name);
    if (readExpectedGeneratedLaunchdPlist(name, plistPath(name)) === null) return false;
    const wasLoaded = await this.bootout(name);
    if (wasLoaded) this.bootedOutServices.add(name);
    return wasLoaded;
  }

  async restart(name: string): Promise<void> {
    assertValidLaunchdInstanceName(name);
    if (readExpectedGeneratedLaunchdPlist(name, plistPath(name)) === null) {
      throw new Error('launchd plist is installed only after successful authentication; authenticate the instance before starting');
    }
    await this.stop(name);
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

    child.kill(SIGNAL.TERM);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(SIGNAL.KILL); } catch { /* already exited: the graceful stop above may have already reaped the child, so kill throwing here is expected and safe to ignore. */ }
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
