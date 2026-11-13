import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  M365_PLUGIN_KEY,
  m365MutationAdmissionGap,
  m365MutationExceptionAllowed,
  m365WorkflowAuthorityLive,
  narrowM365RoutePolicy,
  resolveM365MutationPolicy,
  supportsM365BridgeProvider,
  withdrawM365WorkflowAuthority,
  type M365MutationPolicy,
  type ResolveM365MutationPolicyOptions,
} from '../../core/m365-bridge-policy.ts';
import { ensurePermissionsSettings } from '../../core/workspace.ts';
import { createChildLogger } from '../../logger.ts';
import { isNonEmptyString, isRecord } from '../../lib/type-guards.ts';
import type { SessionTokenRegistry } from '../../mcp/caller-attribution.ts';
import { canonicalM365WorkflowParams } from '../../mcp/m365-workflow-authority.ts';
import type { ToolRegistry } from '../../mcp/registry.ts';
import {
  createMicrosoft365Tool,
  type Microsoft365Launch,
} from '../../mcp/tools/microsoft365.ts';
import type { ResolvedSessionContext, SessionContext } from '../../mcp/types.ts';
import type { PerChatMcpSocketManager } from './per-chat-mcp-socket-manager.ts';
import { buildBaseChildEnv, isConfigRootIsolationEnabled } from './providers/child-env.ts';
import { resolveAgentTurnMapKey } from './scheduled-agent-job-isolation.ts';

const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json');
const PLUGIN_ENTRY = join('mcp-server', 'dist', 'index.cjs');
/** Plugin-root files from which the Claude CLI also loads MCP servers and hooks. */
const PLUGIN_ROOT_FILES = ['.mcp.json', join('hooks', 'hooks.json')] as const;
const PLUGIN_NAME = 'microsoft_365';
const PLUGIN_SERVER = 'microsoft_365';
const PLUGIN_ENTRY_ARGUMENT = '${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.cjs';
/** The Claude CLI's record of marketplace installs, relative to its config directory. */
const NATIVE_INSTALL_RECORD = join('plugins', 'installed_plugins.json');
const AGENT365_LAUNCHER_RELEASE = /^[a-f0-9]{7,64}$/;
const PYTHON_LAUNCHER_NAME = /^python(?:3(?:\.\d+)?)?$/;
const GROUP_OR_WORLD_WRITABLE = 0o022;
const STICKY_DIRECTORY = 0o1000;
const OWNER_EXECUTABLE = 0o100;
const REQUIRED_MANIFEST_ENV = [
  'MS365_CLIENT_ID',
  'MS365_TENANT_ID',
  'MS365_PROFILE',
  'MS365_WORKFLOW_AUTHORITY_REQUIRED',
] as const;
const REQUIRED_POLICY_ENV = [
  'ALLOW_M365_MUTATIONS',
  'MS365_AGENT365_BRIDGE',
  'MS365_AGENT365_BASE_URL',
  'MS365_AGENT365_API_KEY',
  'MS365_AGENT365_ACCOUNT_ID',
  'MS365_TENANT_ID',
  'MS365_PROFILE',
  'MS365_HUB_URL',
  'MS365_DURABLE_MAIL_STATE_DIR',
] as const;
const OPTIONAL_POLICY_ENV = ['MS365_AGENT365_ACCOUNT_EMAIL'] as const;
const SYSTEM_LAUNCHER_ENV = ['PATH', 'TMPDIR', 'LANG'] as const;

interface PluginServerManifest {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

interface PluginManifest {
  name?: unknown;
  version?: unknown;
  mcpServers?: Record<string, PluginServerManifest>;
  hooks?: unknown;
}

/** The admitted `pluginDirs` copy: what the adapter launches and what the native copy must repeat. */
interface PluginPin {
  /** The path as configured: the Claude CLI receives it through `--plugin-dir`, so it is resolved again at each check. */
  configuredDir: string;
  /** Its real path at admission. */
  root: string;
  manifestPath: string;
  /** The real path the entry resolved to at admission; the entry symlink is resolved again at each check. */
  entryPath: string;
  manifestDigest: string;
  entryDigest: string;
  /** Canonical JSON of the manifest's `mcpServers` and `hooks`. */
  shape: string;
}

function pluginShape(manifest: PluginManifest): string | null {
  return canonicalM365WorkflowParams({ mcpServers: manifest.mcpServers ?? null, hooks: manifest.hooks ?? null });
}

/** The guarded shape both copies must have: exactly the one `microsoft_365` server and no `hooks` key. */
function hasCanonicalShape(manifest: PluginManifest): boolean {
  const servers: unknown = manifest.mcpServers;
  return isRecord(servers)
    && Object.keys(servers).length === 1
    && Object.prototype.hasOwnProperty.call(servers, PLUGIN_SERVER)
    && !Object.prototype.hasOwnProperty.call(manifest, 'hooks');
}

/**
 * True only when nothing exists at the path (ENOENT). `lstat` sees a dangling or looping symlink, and any other
 * error (EACCES, EIO, ENOTDIR and so on) proves nothing, so neither counts as absent.
 */
function isAbsent(path: string): boolean {
  return lstatErrorCode(path) === 'ENOENT';
}

/** The error code `lstat` fails with, `unknown` for an error without one, or undefined when it succeeds. */
function lstatErrorCode(path: string): string | undefined {
  try {
    lstatSync(path);
    return undefined;
  } catch (err) {
    const code = isRecord(err) ? err['code'] : undefined;
    return typeof code === 'string' ? code : 'unknown';
  }
}

/** The plugin-root files from which the Claude CLI also loads servers and hooks are absent, as the canonical shape requires. */
function rootFilesAbsent(root: string): boolean {
  return PLUGIN_ROOT_FILES.every((file) => isAbsent(join(root, file)));
}

const LIST_COMMAND = '/bin/ls';
const LIST_TIMEOUT_MS = 2_000;
/** The mode field of an `ls -l` line and its marker: `@` extended attributes or `+` ACL on macOS, `.` SELinux or `+` ACL on Linux. */
const LISTING_MODE = /^[-a-zA-Z?]{10}([@+.]?)$/;
/** A macOS `ls -le` ACL entry line: `N: <principal> [inherited] allow|deny <rights>`. */
const DARWIN_ACL_ENTRY = /^ *\d+: .+ (allow|deny) [a-z_,]+$/;

/** How the ACL rule runs `ls`; injectable so every platform branch can be tested on any host. */
export type AclListingRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

/**
 * Node has no ACL API, so the verdict comes from `/bin/ls`, run by absolute path with an argument vector and no
 * shell. On macOS, `ls -lde` prints every ACL entry after the listing line, even when extended attributes replace
 * the `+` marker with `@`: any `allow` entry refuses, inherited or not, and deny-only entries are admitted because
 * they grant nothing (every macOS home directory carries `group:everyone deny delete`). Linux ACLs have no deny
 * entries, so the `+` marker refuses. A failed or unparseable listing, or any other platform, refuses.
 */
export function aclListingGrantsNothing(
  path: string,
  platform: NodeJS.Platform = process.platform,
  run: AclListingRunner = spawnSync,
): boolean {
  const darwin = platform === 'darwin';
  if ((!darwin && platform !== 'linux') || /[\n\r]/.test(path)) return false;
  try {
    const listing = run(LIST_COMMAND, [darwin ? '-lde' : '-ld', '--', path], {
      encoding: 'utf8', env: { LC_ALL: 'C' }, shell: false, stdio: ['ignore', 'pipe', 'ignore'], timeout: LIST_TIMEOUT_MS,
    });
    if (listing.error !== undefined || listing.status !== 0 || typeof listing.stdout !== 'string') return false;
    const lines = listing.stdout.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const marker = LISTING_MODE.exec(lines[0]?.split(' ', 1)[0] ?? '')?.[1];
    if (marker === undefined) return false;
    if (!darwin) return lines.length === 1 && (marker === '' || marker === '.');
    const entries = lines.slice(1);
    if (marker === '.' || (marker === '+' && entries.length === 0)) return false;
    return entries.every((line) => DARWIN_ACL_ENTRY.exec(line)?.[1] === 'deny');
  } catch {
    return false;
  }
}

/**
 * ACL verdicts of the one top-level check that is running: an admission, a re-check or an adapter launch check
 * walks the same ancestors many times, so each path is listed once per check. A verdict is never reused by a
 * later check, because a filesystem with coarse change times (HFS+ keeps whole seconds) can change an ACL
 * without changing the inode or its ctime.
 */
let aclVerdicts: Map<string, boolean> | undefined;

/** Runs one top-level check with its own ACL verdicts; a nested call shares its caller's. */
function withAclVerdicts<T>(check: () => T): T {
  if (aclVerdicts !== undefined) return check();
  aclVerdicts = new Map();
  try {
    return check();
  } finally {
    aclVerdicts = undefined;
  }
}

function hasNoAclGrant(path: string, stat: Stats): boolean {
  const key = `${path}\0${stat.dev}\0${stat.ino}\0${stat.ctimeMs}`;
  const known = aclVerdicts?.get(key);
  if (known !== undefined) return known;
  const verdict = aclListingGrantsNothing(path);
  aclVerdicts?.set(key, verdict);
  return verdict;
}

function containedPath(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix !== '' && !suffix.startsWith('..') && !isAbsolute(suffix);
}

function parseManifest(path: string): { manifest: PluginManifest; raw: string } | undefined {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return { manifest: parsed as PluginManifest, raw };
  } catch {
    return undefined;
  }
}

function exactManifestEnvironment(
  value: unknown,
  policy: Extract<M365MutationPolicy, { status: 'approved' }>,
): NodeJS.ProcessEnv | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const env = value as Record<string, unknown>;
  if (Object.keys(env).some((key) => !REQUIRED_MANIFEST_ENV.includes(key as typeof REQUIRED_MANIFEST_ENV[number]))) return undefined;
  if (Object.keys(env).length !== REQUIRED_MANIFEST_ENV.length) return undefined;
  if (!REQUIRED_MANIFEST_ENV.every((key) => isNonEmptyString(env[key]) && env[key].trim() === env[key])) return undefined;
  if (
    env.MS365_TENANT_ID !== policy.childEnv.MS365_TENANT_ID
    || env.MS365_PROFILE !== 'user-full-v1'
    || env.MS365_PROFILE !== policy.childEnv.MS365_PROFILE
    || env.MS365_WORKFLOW_AUTHORITY_REQUIRED !== '1'
  ) return undefined;
  return env as NodeJS.ProcessEnv;
}

function safeEnvironmentValue(value: unknown): value is string {
  return isNonEmptyString(value) && !value.includes('\0');
}

function projectedPolicyEnvironment(
  policy: Extract<M365MutationPolicy, { status: 'approved' }>,
): NodeJS.ProcessEnv | undefined {
  const env: NodeJS.ProcessEnv = {};
  for (const key of REQUIRED_POLICY_ENV) {
    if (!safeEnvironmentValue(policy.childEnv[key])) return undefined;
    env[key] = policy.childEnv[key];
  }
  if (!isAbsolute(env.MS365_DURABLE_MAIL_STATE_DIR ?? '')) return undefined;
  for (const key of OPTIONAL_POLICY_ENV) {
    if (safeEnvironmentValue(policy.childEnv[key])) env[key] = policy.childEnv[key];
  }
  return env;
}

function launcherSystemEnvironment(): NodeJS.ProcessEnv | undefined {
  try {
    const home = realpathSync(homedir());
    const username = userInfo().username;
    if (!safeEnvironmentValue(home) || !safeEnvironmentValue(username)) return undefined;
    const env: NodeJS.ProcessEnv = { HOME: home, USER: username, LOGNAME: username };
    const baseEnv = buildBaseChildEnv({ includeMicrosoft365Bridge: false });
    for (const key of SYSTEM_LAUNCHER_ENV) {
      if (safeEnvironmentValue(baseEnv[key])) env[key] = baseEnv[key];
    }
    return env;
  } catch {
    return undefined;
  }
}

function isFixedBridgeInvocation(args: unknown): args is [string, '--config', string, '--', typeof PLUGIN_ENTRY_ARGUMENT] {
  return Array.isArray(args)
    && args.length === 5
    && isNonEmptyString(args[0])
    && isAbsolute(args[0])
    && !args[0].includes('\0')
    && args[0].endsWith('/m365_bridge_launcher.py')
    && args[1] === '--config'
    && isNonEmptyString(args[2])
    && isAbsolute(args[2])
    && !args[2].includes('\0')
    && args[2].endsWith('/m365-bridge.json')
    && args[3] === '--'
    && args[4] === PLUGIN_ENTRY_ARGUMENT;
}

function isCurrentUserOwned(stat: Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return uid !== undefined && stat.uid === uid;
}

function isTrustedOwner(stat: Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return uid !== undefined && (stat.uid === 0 || stat.uid === uid);
}

/**
 * The path, every symlink hop and every ancestor belong to root or this user, carry no ACL entry
 * that grants anything, and are not group- or world-writable, apart from sticky directories. Used
 * for the interpreter and for the plugin code that receives the bridge credentials.
 */
function hasSafePathChain(path: string): boolean {
  try {
    const pending = [path];
    const checked = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (checked.has(current)) continue;
      checked.add(current);
      const stat = lstatSync(current);
      if (!isTrustedOwner(stat) || !hasNoAclGrant(current, stat)) return false;
      if (stat.isSymbolicLink()) {
        pending.push(resolve(dirname(current), readlinkSync(current)));
      } else if ((stat.mode & GROUP_OR_WORLD_WRITABLE) !== 0) {
        if (!stat.isDirectory() || (stat.mode & STICKY_DIRECTORY) === 0) return false;
      }
      const parent = dirname(current);
      if (parent !== current) pending.push(parent);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Admit only the absolute Python interpreter fixed by the installed M365
 * manifest. Every symlink hop and its ancestors are checked so a symlinked
 * venv interpreter cannot cross into an unsafe ownership or writable boundary.
 */
function resolvePythonLauncher(value: unknown): string | undefined {
  if (
    !isNonEmptyString(value)
    || value.trim() !== value
    || value.includes('\0')
    || !isAbsolute(value)
    || !PYTHON_LAUNCHER_NAME.test(basename(value))
  ) return undefined;
  try {
    const resolved = realpathSync(value);
    const stat = statSync(resolved);
    if (!stat.isFile() || (stat.mode & OWNER_EXECUTABLE) === 0) return undefined;
    accessSync(value, constants.X_OK);
    // Python uses its invocation path to locate pyvenv.cfg and installed packages.
    return hasSafePathChain(value) && hasSafePathChain(resolved)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function isSafeOwnedPath(path: string, kind: 'directory' | 'file', privateFile = false): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !isCurrentUserOwned(stat) || !hasNoAclGrant(path, stat)) return false;
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) return false;
    if (realpathSync(path) !== path) return false;
    return (stat.mode & (privateFile ? 0o077 : 0o022)) === 0;
  } catch {
    return false;
  }
}

/**
 * The installed launcher is a same-user filesystem trust boundary, not an
 * attested artifact: no content-pinning service exists here. Admit only the
 * canonical layout and let the launcher retain responsibility for semantic
 * account/config validation.
 */
function isInstalledCanonicalBridge(args: [string, '--config', string, '--', typeof PLUGIN_ENTRY_ARGUMENT]): boolean {
  try {
    const home = realpathSync(homedir());
    const launcherRoot = join(home, '.local', 'opt', 'agent365', 'launchers');
    const release = basename(dirname(args[0]));
    const expectedLauncher = join(launcherRoot, release, 'm365_bridge_launcher.py');
    const expectedConfig = join(home, '.config', 'agent365', 'm365-bridge.json');
    if (
      !AGENT365_LAUNCHER_RELEASE.test(release)
      || args[0] !== expectedLauncher
      || args[2] !== expectedConfig
    ) return false;
    const launcherDirectories = [
      home,
      join(home, '.local'),
      join(home, '.local', 'opt'),
      join(home, '.local', 'opt', 'agent365'),
      launcherRoot,
      join(launcherRoot, release),
    ];
    const configDirectories = [
      join(home, '.config'),
      join(home, '.config', 'agent365'),
    ];
    return launcherDirectories.every((path) => isSafeOwnedPath(path, 'directory'))
      && configDirectories.every((path) => isSafeOwnedPath(path, 'directory'))
      && isSafeOwnedPath(expectedLauncher, 'file')
      && isSafeOwnedPath(expectedConfig, 'file', true);
  } catch {
    return false;
  }
}

/**
 * Resolves the installed Microsoft plugin from an already configured plugin
 * directory. The manifest fixes an audited bridge invocation, including its
 * installed Python interpreter, and is never resolved through PATH.
 */
export function loadMicrosoft365PluginLaunch(
  pluginDirs: readonly string[],
  policy: M365MutationPolicy | undefined,
): Microsoft365Launch | undefined {
  return loadPluginCandidate(pluginDirs, policy)?.launch;
}

function loadPluginCandidate(
  pluginDirs: readonly string[],
  policy: M365MutationPolicy | undefined,
): { launch: Microsoft365Launch; pin: PluginPin } | undefined {
  return withAclVerdicts(() => loadPluginCandidateChecked(pluginDirs, policy));
}

function loadPluginCandidateChecked(
  pluginDirs: readonly string[],
  policy: M365MutationPolicy | undefined,
): { launch: Microsoft365Launch; pin: PluginPin } | undefined {
  if (policy?.status !== 'approved') return undefined;
  const accountId = policy.childEnv.MS365_AGENT365_ACCOUNT_ID;
  if (!isNonEmptyString(accountId) || accountId !== accountId.trim()) return undefined;

  const candidates: Array<{ launch: Microsoft365Launch; pin: PluginPin }> = [];
  for (const configuredDir of pluginDirs) {
    try {
      const root = realpathSync(configuredDir);
      const manifestPath = join(root, PLUGIN_MANIFEST);
      // The plugin receives the bridge credentials and enforces broker authorization, so the
      // configured path, its manifest, entry and their directories get the interpreter's trust rule.
      if (
        !hasSafePathChain(configuredDir) || !hasSafePathChain(manifestPath) || !hasSafePathChain(join(root, PLUGIN_ENTRY))
        || !statSync(manifestPath).isFile()
      ) continue;
      const parsed = parseManifest(manifestPath);
      if (!parsed || parsed.manifest.name !== PLUGIN_NAME || typeof parsed.manifest.version !== 'string' || !parsed.manifest.version.trim()) continue;
      // The Claude CLI loads every server and hook the copy declares, so only the canonical shape is admitted.
      if (!hasCanonicalShape(parsed.manifest) || !rootFilesAbsent(root)) continue;
      const server = parsed.manifest.mcpServers?.[PLUGIN_SERVER];
      const pythonLauncher = resolvePythonLauncher(server?.command);
      if (
        !server
        || pythonLauncher === undefined
        || !isFixedBridgeInvocation(server.args)
        || !isInstalledCanonicalBridge(server.args)
      ) continue;
      const entry = realpathSync(join(root, PLUGIN_ENTRY));
      if (!containedPath(root, entry) || !statSync(entry).isFile() || !hasSafePathChain(entry)) continue;
      const manifestEnv = exactManifestEnvironment(server.env, policy);
      const policyEnv = projectedPolicyEnvironment(policy);
      const systemEnv = launcherSystemEnvironment();
      const entryDigest = fileDigest(entry);
      const shape = pluginShape(parsed.manifest);
      if (manifestEnv === undefined || policyEnv === undefined || systemEnv === undefined || entryDigest === undefined || shape === null) continue;
      const manifestDigest = createHash('sha256').update(parsed.raw, 'utf8').digest('hex');
      candidates.push({
        launch: {
          command: pythonLauncher,
          args: [server.args[0], '--config', server.args[2], '--', entry],
          // The manifest has a deliberately small non-secret environment. The
          // process-bound policy adds its account and credential projection only
          // after those fixed manifest values have matched it.
          env: { ...systemEnv, ...policyEnv, ...manifestEnv },
          catalogVersion: `${parsed.manifest.version}:${manifestDigest}`,
          accountId,
        },
        pin: { configuredDir, root, manifestPath, entryPath: entry, manifestDigest, entryDigest, shape },
      });
    } catch {
      // Deliberately: omit an absent or altered plugin so registry admission fails closed.
    }
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

export interface RegisterMicrosoft365AdapterOptions {
  registry: ToolRegistry;
  policy: M365MutationPolicy | undefined;
  pluginDirs: readonly string[];
  perChatMcpSocketManager: PerChatMcpSocketManager;
  resolvePerChatMapKey: (deliveryJid: string) => string;
  sessionTokens: SessionTokenRegistry;
  /** Sandboxed per_chat runtimes run scheduled jobs on the chat's own turn key. */
  sandboxPerChat?: boolean;
  /** Names the instance in the adapter's log lines. */
  instanceName?: string;
}

/**
 * The broker socket key for a session's own executing turn. A scheduled job keeps
 * its isolation suffix, so the broker resolves that job's context and never a live
 * turn of the same chat. Only a scheduled key carries the scheduled purpose as its
 * static fallback; a shared chat key relies on the executing turn's own purpose.
 */
export function microsoft365AuthorityKey(
  session: Pick<SessionContext, 'deliveryJid' | 'purpose'> & { deliveryJid: string },
  options: Pick<RegisterMicrosoft365AdapterOptions, 'resolvePerChatMapKey' | 'sandboxPerChat'>,
): { mapKey: string; purpose: SessionContext['purpose'] } {
  const baseKey = options.resolvePerChatMapKey(session.deliveryJid);
  const mapKey = resolveAgentTurnMapKey(baseKey, session.purpose === 'scheduled-agent-job' && options.sandboxPerChat !== true);
  return { mapKey, purpose: mapKey === baseKey ? undefined : 'scheduled-agent-job' };
}

/** Register the single adapter only when a fixed launcher and account binding exist. */
export function registerMicrosoft365Adapter(options: RegisterMicrosoft365AdapterOptions): boolean {
  return registerAdapterLaunch(options) !== undefined;
}

/**
 * The admitted `pluginDirs` copy changed on any surface the Claude CLI loads: the configured path or the entry
 * symlink resolves elsewhere, the manifest or entry bytes differ, a plugin-root `.mcp.json` or `hooks/hooks.json`
 * is no longer absent, or a path lost the trust rule. Any error counts as a change.
 */
function pluginCopyChanged(pin: PluginPin): boolean {
  try {
    const entryLink = join(pin.root, PLUGIN_ENTRY);
    return realpathSync(pin.configuredDir) !== pin.root || realpathSync(entryLink) !== pin.entryPath
      || !hasSafePathChain(pin.configuredDir) || !hasSafePathChain(pin.manifestPath) || !hasSafePathChain(entryLink)
      || fileDigest(pin.manifestPath) !== pin.manifestDigest || fileDigest(pin.entryPath) !== pin.entryDigest
      || !rootFilesAbsent(pin.root);
  } catch {
    return true;
  }
}

function registerAdapterLaunch(options: RegisterMicrosoft365AdapterOptions): { launch: Microsoft365Launch; pin: PluginPin } | undefined {
  const candidate = loadPluginCandidate(options.pluginDirs, options.policy);
  if (candidate === undefined) return undefined;
  const { launch, pin } = candidate;
  let copyChanged = false;

  /**
   * The adapter's launch check: once before it acquires a socket, and again inside the tool immediately before it
   * spawns the plugin with the bridge credentials, after every await. An admitted policy gets the runtime's full
   * re-check (the assignment and both copies), which withdraws the assignment on failure. Without an admitted
   * assignment only this copy, the one the adapter launches, is checked. A failure closes the adapter for the run.
   */
  const launchAllowed = (): boolean => withAclVerdicts(() => {
    if (copyChanged) return false;
    const policy = options.policy;
    if (policy?.status === 'approved' && admittedPlugins.has(policy)) {
      copyChanged = recheckMicrosoft365Workflow(policy, options.instanceName) !== policy;
    } else if (pluginCopyChanged(pin)) {
      if (policy?.status === 'approved' && policy.workflowAuthority !== undefined) withdrawM365WorkflowAuthority(policy.workflowAuthority);
      log.warn({ instance: options.instanceName, reason: 'plugin-differs' }, WITHDRAWAL_MESSAGE);
      copyChanged = true;
    }
    return !copyChanged;
  });

  options.registry.register(createMicrosoft365Tool({
    launch,
    launchAllowed,
    authorityForSession: async (session: SessionContext) => {
      // An unresolved context means no turn is executing, and its purpose is not
      // known: never fall back to the chat's live socket for it. A turn on a route
      // whose provider or policy is not admitted (for example a codex-cli fallback)
      // gets neither reads nor writes, and neither does a turn whose published
      // assignment was withdrawn after it started (its next turn would publish nothing).
      if (
        session.tier !== 'chat-scoped'
        || !session.deliveryJid
        || (session as Partial<ResolvedSessionContext>).executingResolution !== 'resolved'
        || !supportsM365BridgeProvider(session.m365RouteProvider)
        || (session.workflowAuthority !== undefined && !m365WorkflowAuthorityLive(session.workflowAuthority))
      ) return undefined;
      // Checked before a socket is acquired; the tool checks again immediately before the spawn.
      if (!launchAllowed()) return undefined;
      const key = microsoft365AuthorityKey({ deliveryJid: session.deliveryJid, purpose: session.purpose }, options);
      const resource = options.perChatMcpSocketManager.acquire(key.mapKey, session.deliveryJid, key.purpose);
      await resource.ready;
      // One token per call, bound to this socket and this turn; the tool revokes it when the call settles.
      const lease = options.sessionTokens.mintLease({
        kind: 'request',
        socketPath: resource.socketPath,
        conversationKey: session.conversationKey,
        requestRef: session.requestRef,
      });
      return {
        socketPath: resource.socketPath,
        sessionToken: lease.token,
        accountId: launch.accountId,
        release: lease.revoke,
      };
    },
  }));
  return candidate;
}

/** Why a plugin copy cannot carry workflow authority; a reason, never a path. */
type NativePluginMismatch =
  | 'install-record-unreadable' | 'not-installed' | 'unsafe-path' | 'manifest-differs' | 'entry-unreadable' | 'entry-differs'
  | 'plugin-differs' | 'config-root-isolation';

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fileDigest(path: string): string | undefined {
  try {
    return sha256File(path);
  } catch {
    return undefined;
  }
}

/**
 * The `claude-cli` provider also loads the copy that `enabledPlugins` names, from the
 * install record in its config directory. Every install must repeat the admitted plugin:
 * the same single server (command, arguments and environment), no other servers or hooks,
 * no plugin-root `.mcp.json` or `hooks/hooks.json`, and the guarded entry byte for byte,
 * resolved again each time. Its record, root, manifest and entry get the admitted copy's
 * trust rule. Otherwise it could receive the bridge credentials without enforcing employee
 * authorization.
 */
function nativePluginMismatch(pin: PluginPin): NativePluginMismatch | undefined {
  let installs: unknown;
  // env-allowed: external-tool interop; must track the config dir the spawned claude CLI reads
  const recordPath = join(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), NATIVE_INSTALL_RECORD);
  try {
    const record: unknown = JSON.parse(readFileSync(recordPath, 'utf8'));
    installs = isRecord(record) && isRecord(record['plugins']) ? record['plugins'][M365_PLUGIN_KEY] : undefined;
  } catch {
    return 'install-record-unreadable';
  }
  if (!hasSafePathChain(recordPath)) return 'unsafe-path';
  const list: unknown[] = Array.isArray(installs) ? installs : installs === undefined ? [] : [installs];
  if (list.length === 0) return 'not-installed';
  for (const install of list) {
    const installPath = isRecord(install) ? install['installPath'] : undefined;
    if (!isNonEmptyString(installPath) || !isAbsolute(installPath)) return 'not-installed';
    try {
      const root = realpathSync(installPath);
      const manifestPath = join(root, PLUGIN_MANIFEST);
      if (!hasSafePathChain(installPath) || !hasSafePathChain(manifestPath) || !hasSafePathChain(join(root, PLUGIN_ENTRY))) return 'unsafe-path';
      const manifest = parseManifest(manifestPath)?.manifest;
      if (
        manifest === undefined || !hasCanonicalShape(manifest) || pluginShape(manifest) !== pin.shape || !rootFilesAbsent(root)
      ) return 'manifest-differs';
      const entry = realpathSync(join(root, PLUGIN_ENTRY));
      if (!containedPath(root, entry) || !statSync(entry).isFile() || !hasSafePathChain(entry)) return 'entry-unreadable';
      if (sha256File(entry) !== pin.entryDigest) return 'entry-differs';
    } catch {
      return 'entry-unreadable';
    }
  }
  return undefined;
}

const log = createChildLogger('microsoft365-adapter');
const WITHDRAWAL_MESSAGE = 'Microsoft 365 workflow authority withdrawn: a plugin copy does not match the admitted guarded plugin, so Microsoft 365 writes stay denied';

/** The admitted plugin copy, per policy that kept its workflow assignment at admission. */
const admittedPlugins = new WeakMap<M365MutationPolicy, PluginPin>();
/**
 * Policies withdrawn because no guarded plugin was admitted or a plugin copy changed: their
 * `claude-cli` children get no bridge values at all.
 */
const pluginWithdrawals = new WeakSet<M365MutationPolicy>();

/** The assignment-free policy every later spawn is rejected under. */
function pluginWithdrawn(policy: Extract<M365MutationPolicy, { status: 'approved' }>): M365MutationPolicy {
  const withdrawn: M365MutationPolicy = { status: 'approved', childEnv: policy.childEnv };
  pluginWithdrawals.add(withdrawn);
  return withdrawn;
}

/** `midRun`: the assignment may already be published, so its turns lose it at their next request. */
function withdrawnForNativeCopy(
  policy: Extract<M365MutationPolicy, { status: 'approved' }>,
  reason: NativePluginMismatch,
  instanceName: string | undefined,
  midRun = false,
): M365MutationPolicy {
  log.warn({ instance: instanceName, reason }, WITHDRAWAL_MESSAGE);
  if (midRun && policy.workflowAuthority !== undefined) withdrawM365WorkflowAuthority(policy.workflowAuthority);
  return pluginWithdrawn(policy);
}

/**
 * Resolves the runtime's M365 policy. When a configured bridge keeps Microsoft 365
 * writes denied, the startup log names the setting to fix (a name, never a value).
 */
export function resolveExplainedM365MutationPolicy(options: ResolveM365MutationPolicyOptions): M365MutationPolicy | undefined {
  const policy = resolveM365MutationPolicy(options);
  if (policy?.status === 'rejected') {
    log.warn({ instance: options.instanceName, missing: m365MutationAdmissionGap(options) },
      'Microsoft 365 bridge not admitted: the named setting is missing or does not match; Microsoft 365 tools stay unavailable');
  } else if (policy?.status === 'approved' && policy.workflowAuthority === undefined) {
    log.warn({ instance: options.instanceName, missing: 'agentOptions.m365Bridge.workflowAuthority' },
      'Microsoft 365 bridge admitted without workflowAuthority: Microsoft 365 writes stay denied');
  }
  return policy;
}

/**
 * Registers the adapter and returns the policy the runtime may use. Employee-bound
 * writes rely on the guarded plugin. Without its admission, or when the native copy
 * that `enabledPlugins` names does not run the same guarded entry, the workflow
 * assignment is withdrawn, so the mutation deny floor stays on every route (settings,
 * fallback, session and native plugin) and the broker refuses writes. A policy without
 * an assignment (no `workflowAuthority`, or an `accountEmail` binding) is returned
 * unchecked: its `claude-cli` children still get the bridge environment and load the
 * native copy, and only the settings deny floor guards native writes.
 */
export function admitMicrosoft365Workflow(options: RegisterMicrosoft365AdapterOptions): M365MutationPolicy | undefined {
  return withAclVerdicts(() => admitMicrosoft365WorkflowChecked(options));
}

function admitMicrosoft365WorkflowChecked(options: RegisterMicrosoft365AdapterOptions): M365MutationPolicy | undefined {
  const candidate = registerAdapterLaunch(options);
  const policy = options.policy;
  if (policy?.status !== 'approved' || policy.workflowAuthority === undefined) return policy;
  if (candidate === undefined) {
    log.warn({ instance: options.instanceName, missing: 'guarded Microsoft 365 plugin under agentOptions.pluginDirs' },
      'Microsoft 365 workflow authority withdrawn: no guarded plugin was admitted, so Microsoft 365 writes stay denied');
    // Nothing verified the plugin that claude-cli loads, so it gets the bridge credentials no more than after a withdrawal.
    return pluginWithdrawn(policy);
  }
  // An isolated child config root holds another install record than the one checked here.
  const mismatch = isConfigRootIsolationEnabled() ? 'config-root-isolation' : nativePluginMismatch(candidate.pin);
  if (mismatch !== undefined) return withdrawnForNativeCopy(policy, mismatch, options.instanceName);
  admittedPlugins.set(policy, candidate.pin);
  return policy;
}

/**
 * The single authority-and-bytes re-check. Every launch that can load the guarded plugin with the
 * bridge credentials runs it immediately before its process is spawned: each `claude-cli` provider
 * spawn (through the runtime's `microsoft365SpawnPolicy` closure) and each adapter launch (its
 * `launchAllowed`). It also runs before each native-settings write and each turn's publication. A
 * marketplace update can replace either plugin copy mid-run, so every loading surface of both copies
 * must still match the admitted plugin and the assignment must still be live; otherwise the
 * assignment is withdrawn and turns that already published it lose it at their next request.
 * The withdrawn policy carries no assignment, so the withdrawal holds for the rest of the run
 * and is logged once. A policy without an assignment passes through with neither copy checked:
 * its children still get the bridge environment, and the settings deny floor is their only
 * native-write guard. Any other policy with an assignment, including an equal copy of the
 * admitted one, was never admitted and is rejected.
 */
export function recheckMicrosoft365Workflow(policy: M365MutationPolicy | undefined, instanceName?: string): M365MutationPolicy | undefined {
  return withAclVerdicts(() => recheckMicrosoft365WorkflowChecked(policy, instanceName));
}

function recheckMicrosoft365WorkflowChecked(policy: M365MutationPolicy | undefined, instanceName?: string): M365MutationPolicy | undefined {
  if (policy?.status !== 'approved' || policy.workflowAuthority === undefined) return policy;
  const pin = admittedPlugins.get(policy);
  if (pin === undefined) {
    log.warn({ instance: instanceName, reason: 'not-admitted' },
      'Microsoft 365 policy rejected: it carries a workflow assignment that the plugin admission did not keep');
    return { status: 'rejected' };
  }
  const mismatch = !m365WorkflowAuthorityLive(policy.workflowAuthority) || pluginCopyChanged(pin) ? 'plugin-differs'
    : isConfigRootIsolationEnabled() ? 'config-root-isolation'
      : nativePluginMismatch(pin);
  return mismatch === undefined ? policy : withdrawnForNativeCopy(policy, mismatch, instanceName, true);
}

/**
 * The policy a session's provider child gets, read at every spawn after the caller's re-check
 * (`current`), so an in-place respawn of an existing session never reuses a stale approval. A
 * snapshot whose assignment was withdrawn is rejected: `claude-cli` then gets `--disallowedTools`
 * with the full deny set and no bridge or workflow-authority values. When startup admitted no
 * guarded plugin, or after a plugin-copy withdrawal, every child is rejected that way. A policy
 * that never carried an assignment is not rejected: its child gets the bridge environment with
 * no native-copy check, under the settings deny floor. While any deny-floor rewrite is pending
 * the spawn is refused, because a settings file may still lift the floor.
 */
export function microsoft365SpawnPolicy(
  snapshot: M365MutationPolicy | undefined,
  current: M365MutationPolicy | undefined,
  files: Microsoft365SettingsFiles,
): M365MutationPolicy | undefined {
  if (files.hasPendingRestoration()) {
    // One actionable line per refused spawn: each file to repair and the error code that keeps its rewrite pending.
    log.error({ pending: files.pendingRestorations() },
      'Microsoft 365 provider spawn refused: the deny floor rewrite of each named settings file is still pending; repair its access (see code) and the next check retries it');
    throw new Error('M365_FLOOR_RESTORATION_PENDING: a Microsoft 365 deny floor rewrite is pending, so the provider spawn is refused');
  }
  const narrowed = narrowM365RoutePolicy(snapshot, current);
  return narrowed?.status === 'approved' && current !== undefined && pluginWithdrawals.has(current) ? { status: 'rejected' } : narrowed;
}

/** Which native settings file a runtime wrote, logged in place of its path. */
export type Microsoft365SettingsTarget = 'shared' | 'chat';

/**
 * The native settings files a runtime writes: its shared `.claude` directory and each sandboxed
 * chat's. Every write goes through the settings writer and records its directory, its sandbox flag
 * and its plugins, so a withdrawal can restore the deny floor in each file exactly as it was written.
 */
export class Microsoft365SettingsFiles {
  private readonly written = new Map<string, { target: Microsoft365SettingsTarget; enabledPlugins?: Record<string, boolean>; hasSandbox: boolean }>();
  /** Files whose deny-floor rewrite has not succeeded yet: the floor policy to write and the last attempt's error code. */
  private readonly pending = new Map<string, { floor: M365MutationPolicy | undefined; code: string }>();

  write(
    target: Microsoft365SettingsTarget,
    claudeDir: string,
    enabledPlugins: Record<string, boolean> | undefined,
    opts: { hasSandbox: boolean; m365MutationPolicy?: M365MutationPolicy },
  ): void {
    ensurePermissionsSettings(claudeDir, 'agent', enabledPlugins, opts);
    this.written.set(claudeDir, { target, enabledPlugins, hasSandbox: opts.hasSandbox });
    if (!m365MutationExceptionAllowed(opts.m365MutationPolicy)) this.pending.delete(claudeDir);
  }

  /** True while a withdrawal's floor rewrite has failed for some file; provider spawns are refused meanwhile. */
  hasPendingRestoration(): boolean {
    return this.pending.size > 0;
  }

  /** Each settings file whose rewrite is still pending, with the error code that keeps it pending; for the refusal log. */
  pendingRestorations(): Array<{ path: string; code: string }> {
    return [...this.pending].map(([claudeDir, { code }]) => ({ path: join(claudeDir, 'settings.json'), code }));
  }

  /**
   * Runs after each re-check with the runtime policy before and after it, and returns `after`.
   * When the re-check withdrew the assignment, every recorded file is queued for a rewrite with the
   * deny floor. Every call, whether or not it withdrew anything, then writes each queued file before
   * it returns: a failed rewrite stays queued and is retried at the next check. Only a file that is
   * gone (ENOENT: its workspace was removed) is dropped, not recreated; a file that cannot be
   * inspected stays queued. A failed rewrite is logged with a reason, never a path; each spawn refused
   * meanwhile logs the file's path and that error code (`microsoft365SpawnPolicy`). The caller has
   * already stored `after`, so authority stays withdrawn in memory either way.
   */
  restoreFloorOnWithdrawal(
    before: M365MutationPolicy | undefined,
    after: M365MutationPolicy | undefined,
    instanceName?: string,
  ): M365MutationPolicy | undefined {
    if (m365MutationExceptionAllowed(before) && !m365MutationExceptionAllowed(after)) {
      for (const claudeDir of this.written.keys()) this.pending.set(claudeDir, { floor: after, code: 'not-attempted' });
    }
    for (const [claudeDir, entry] of this.pending) {
      const file = this.written.get(claudeDir);
      const inspection = lstatErrorCode(join(claudeDir, 'settings.json'));
      if (file === undefined || inspection === 'ENOENT') {
        this.pending.delete(claudeDir);
        continue;
      }
      try {
        ensurePermissionsSettings(claudeDir, 'agent', file.enabledPlugins, { hasSandbox: file.hasSandbox, m365MutationPolicy: entry.floor });
        this.pending.delete(claudeDir);
      } catch (err) {
        // A failed inspection is the cause an operator can repair; otherwise the write's own error code.
        const code = isRecord(err) ? err['code'] : undefined;
        entry.code = inspection ?? (typeof code === 'string' ? code : 'write-failed');
        log.error({ instance: instanceName, target: file.target, reason: entry.code },
          'Microsoft 365 deny floor not restored in a settings file; it stays pending and provider spawns are refused until a retry succeeds');
      }
    }
    return after;
  }
}
