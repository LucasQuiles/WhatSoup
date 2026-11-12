import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  m365MutationAdmissionGap,
  resolveM365MutationPolicy,
  type M365MutationPolicy,
  type ResolveM365MutationPolicyOptions,
} from '../../core/m365-bridge-policy.ts';
import { createChildLogger } from '../../logger.ts';
import { isNonEmptyString } from '../../lib/type-guards.ts';
import type { SessionTokenRegistry } from '../../mcp/caller-attribution.ts';
import type { ToolRegistry } from '../../mcp/registry.ts';
import {
  createMicrosoft365Tool,
  type Microsoft365Launch,
} from '../../mcp/tools/microsoft365.ts';
import type { ResolvedSessionContext, SessionContext } from '../../mcp/types.ts';
import type { PerChatMcpSocketManager } from './per-chat-mcp-socket-manager.ts';
import { buildBaseChildEnv } from './providers/child-env.ts';
import { resolveAgentTurnMapKey } from './scheduled-agent-job-isolation.ts';

const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json');
const PLUGIN_ENTRY = join('mcp-server', 'dist', 'index.cjs');
const PLUGIN_NAME = 'microsoft_365';
const PLUGIN_SERVER = 'microsoft_365';
const PLUGIN_ENTRY_ARGUMENT = '${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.cjs';
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

function isTrustedInterpreterOwner(stat: Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return uid !== undefined && (stat.uid === 0 || stat.uid === uid);
}

function hasSafeInterpreterPathChain(path: string): boolean {
  try {
    const pending = [path];
    const checked = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (checked.has(current)) continue;
      checked.add(current);
      const stat = lstatSync(current);
      if (!isTrustedInterpreterOwner(stat)) return false;
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
    return hasSafeInterpreterPathChain(value) && hasSafeInterpreterPathChain(resolved)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function isSafeOwnedPath(path: string, kind: 'directory' | 'file', privateFile = false): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !isCurrentUserOwned(stat)) return false;
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
  if (policy?.status !== 'approved') return undefined;
  const accountId = policy.childEnv.MS365_AGENT365_ACCOUNT_ID;
  if (!isNonEmptyString(accountId) || accountId !== accountId.trim()) return undefined;

  const candidates: Microsoft365Launch[] = [];
  for (const configuredDir of pluginDirs) {
    try {
      const root = realpathSync(configuredDir);
      const manifestPath = join(root, PLUGIN_MANIFEST);
      const parsed = parseManifest(manifestPath);
      if (!parsed || parsed.manifest.name !== PLUGIN_NAME || typeof parsed.manifest.version !== 'string' || !parsed.manifest.version.trim()) continue;
      const server = parsed.manifest.mcpServers?.[PLUGIN_SERVER];
      const pythonLauncher = resolvePythonLauncher(server?.command);
      if (
        !server
        || pythonLauncher === undefined
        || !isFixedBridgeInvocation(server.args)
        || !isInstalledCanonicalBridge(server.args)
      ) continue;
      const entry = realpathSync(join(root, PLUGIN_ENTRY));
      if (!containedPath(root, entry) || !statSync(entry).isFile()) continue;
      const manifestEnv = exactManifestEnvironment(server.env, policy);
      const policyEnv = projectedPolicyEnvironment(policy);
      const systemEnv = launcherSystemEnvironment();
      if (manifestEnv === undefined || policyEnv === undefined || systemEnv === undefined) continue;
      candidates.push({
        command: pythonLauncher,
        args: [server.args[0], '--config', server.args[2], '--', entry],
        // The manifest has a deliberately small non-secret environment. The
        // process-bound policy adds its account and credential projection only
        // after those fixed manifest values have matched it.
        env: { ...systemEnv, ...policyEnv, ...manifestEnv },
        catalogVersion: `${parsed.manifest.version}:${createHash('sha256').update(parsed.raw, 'utf8').digest('hex')}`,
        accountId,
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
  const launch = loadMicrosoft365PluginLaunch(options.pluginDirs, options.policy);
  if (launch === undefined) return false;

  options.registry.register(createMicrosoft365Tool({
    launch,
    authorityForSession: async (session: SessionContext) => {
      // An unresolved context means no turn is executing, and its purpose is not
      // known: never fall back to the chat's live socket for it.
      if (
        session.tier !== 'chat-scoped'
        || !session.deliveryJid
        || (session as Partial<ResolvedSessionContext>).executingResolution !== 'resolved'
      ) return undefined;
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
  return true;
}

const log = createChildLogger('microsoft365-adapter');

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
 * writes rely on the guarded plugin. Without its admission the workflow assignment
 * is withdrawn, so the mutation deny floor stays on every route (settings, fallback,
 * session and native plugin) and the broker refuses writes.
 */
export function admitMicrosoft365Workflow(options: RegisterMicrosoft365AdapterOptions): M365MutationPolicy | undefined {
  const admitted = registerMicrosoft365Adapter(options);
  const policy = options.policy;
  if (admitted || policy?.status !== 'approved' || policy.workflowAuthority === undefined) return policy;
  log.warn({ instance: options.instanceName, missing: 'guarded Microsoft 365 plugin under agentOptions.pluginDirs' },
    'Microsoft 365 workflow authority withdrawn: no guarded plugin was admitted, so Microsoft 365 writes stay denied');
  return { status: 'approved', childEnv: policy.childEnv };
}
