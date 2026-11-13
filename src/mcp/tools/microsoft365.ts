import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';

import { M365_ACCOUNT_SELECTION_TOOLS } from '../../core/settings-template.ts';
import { probeGroupMembership, type GroupMembership } from '../../lib/process-group-membership.ts';
import { SIGNAL } from '../../lib/signals.ts';
import { isNonEmptyString, isRecord } from '../../lib/type-guards.ts';
import { EXTERNAL_EFFECT_CONTRACT_VERSION } from '../external-effect.ts';
import { toolError, type SessionContext, type ToolDeclaration } from '../types.ts';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STDOUT_LIMIT_BYTES = 1_048_576;
const DEFAULT_STDERR_LIMIT_BYTES = 65_536;
const TERMINATION_GRACE_MS = 250;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 1_048_576;
/** Bounds the synchronous `ps` read that runs only after a group kill reports EPERM. */
const GROUP_PROBE_TIMEOUT_MS = 1_000;

/** `cleanupUnproven` reports separately that the child's process group may still run. */
type McpOutcome =
  | { kind: 'result'; result: unknown }
  | { kind: 'protocol_error' | 'timeout' | 'output_limit' | 'spawn_error' | 'child_exit'; cleanupUnproven?: true };

/** A request's outcome, or the refusal of its launch check, in which case no process was started. */
type RequestOutcome = McpOutcome | { kind: 'launch_refused' };

export interface Microsoft365Launch {
  /** Fixed absolute executable path for the account-bound Microsoft 365 plugin. */
  command: string;
  /** Fixed plugin argv. Caller-supplied tool data always travels over stdio. */
  args: readonly string[];
  /** Explicit child environment. Ambient process.env is never inherited here. */
  env: NodeJS.ProcessEnv;
  /** Changes when the pinned plugin catalogue changes. */
  catalogVersion: string;
  /** Account selected by the pinned plugin launch configuration. */
  accountId: string;
}

export interface Microsoft365Authority {
  /** Existing chat-scoped broker socket for the current request. */
  socketPath: string;
  /** Per-request token that the broker recognizes as owned by this runtime. */
  sessionToken: string;
  /** Account authorized for this request; must equal the pinned launch account. */
  accountId: string;
  /** Retires the request token. Called once the request settles, whatever its outcome. */
  release?: () => void;
}

export interface Microsoft365ToolOptions {
  launch: Microsoft365Launch;
  authorityForSession: (session: SessionContext) => Promise<Microsoft365Authority | undefined>;
  /**
   * Runs synchronously immediately before each plugin process is spawned, after every await, so a plugin
   * that changed while the authority resolved is never launched with the credentials. False or a throw
   * refuses the spawn.
   */
  launchAllowed: () => boolean;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /**
   * Asks whether a process group still has a live member after a group kill reported EPERM.
   * Defaults to one bounded `ps` read. Injectable for tests.
   */
  probeGroup?: (pgid: number) => GroupMembership;
}

interface ValidatedLaunch {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  catalogVersion: string;
  accountId: string;
}

// The catalogue can be shared by adapter instances only when both the pinned
// plugin version and selected account agree. The launch environment stays out
// of the key because it can contain credentials.
const cataloguesByAccountAndVersion = new Map<string, Promise<RequestOutcome>>();

function isBoundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validatedPositiveOption(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!isBoundedInteger(resolved, maximum)) {
    throw new RangeError(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
  return resolved;
}

function nonEmptyEnvironmentValue(value: unknown): value is string {
  return isNonEmptyString(value) && value.trim() === value && !value.includes('\0');
}

function requireAbsoluteSocket(value: unknown): string | null {
  return nonEmptyEnvironmentValue(value) && isAbsolute(value) ? value : null;
}

function validateLaunch(launch: Microsoft365Launch): ValidatedLaunch {
  if (!isAbsolute(launch.command) || launch.command.includes('\0')) {
    throw new TypeError('Microsoft 365 launch command must be an absolute path without NUL bytes');
  }
  if (!Array.isArray(launch.args) || launch.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TypeError('Microsoft 365 launch arguments must be fixed strings without NUL bytes');
  }
  if (!isNonEmptyString(launch.catalogVersion)) {
    throw new TypeError('Microsoft 365 catalogVersion must be a non-empty string');
  }
  if (!nonEmptyEnvironmentValue(launch.accountId)) {
    throw new TypeError('Microsoft 365 accountId must be a non-empty string without surrounding whitespace or NUL bytes');
  }
  if (launch.env.MS365_AGENT365_ACCOUNT_ID !== launch.accountId) {
    throw new TypeError('Microsoft 365 launch accountId must match MS365_AGENT365_ACCOUNT_ID');
  }
  return {
    command: launch.command,
    args: [...launch.args],
    env: Object.fromEntries(Object.entries(launch.env).filter(([, value]) => typeof value === 'string')),
    catalogVersion: launch.catalogVersion,
    accountId: launch.accountId,
  };
}

function childEnvironment(base: NodeJS.ProcessEnv, authority: Microsoft365Authority): NodeJS.ProcessEnv {
  return {
    ...base,
    MS365_WORKFLOW_AUTHORITY_REQUIRED: '1',
    MS365_WORKFLOW_AUTHORITY_SOCKET: authority.socketPath,
    WHATSOUP_MCP_SESSION_TOKEN: authority.sessionToken,
  };
}

function isMicrosoft365Authority(value: unknown): value is Microsoft365Authority {
  return isRecord(value)
    && typeof value['socketPath'] === 'string'
    && typeof value['sessionToken'] === 'string'
    && typeof value['accountId'] === 'string';
}

function catalogueCacheKey(launch: ValidatedLaunch): string {
  return JSON.stringify([launch.accountId, launch.catalogVersion]);
}

/** Runs exactly one MCP request and tears down the child process group afterwards. */
function requestMcp(
  launch: ValidatedLaunch,
  authority: Microsoft365Authority,
  method: 'tools/list' | 'tools/call',
  params: Record<string, unknown>,
  timeoutMs: number,
  maxStdoutBytes: number,
  maxStderrBytes: number,
  probeGroup: (pgid: number) => GroupMembership,
  launchAllowed: () => boolean,
): Promise<RequestOutcome> {
  return new Promise<RequestOutcome>((resolve) => {
    // Synchronous from this check to spawn(): nothing can change the decision in between.
    let allowed = false;
    try {
      allowed = launchAllowed() === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      resolve({ kind: 'launch_refused' });
      return;
    }
    let child: ReturnType<typeof spawn>;
    let settled = false;
    let initialized = false;
    let cleanupStarted = false;
    let cleanupUnproven = false;
    let outcome: McpOutcome | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutBuffer = '';
    const stdoutDecoder = new StringDecoder('utf8');

    const settle = (next: McpOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(forceKill);
      clearTimeout(cleanupDeadline);
      if (!cleanupUnproven) {
        resolve(next);
        return;
      }
      // The request's own outcome is kept, and the cleanup failure is reported beside it.
      // A completed call is never returned as success while its group may still run.
      resolve(next.kind === 'result' ? { kind: 'protocol_error', cleanupUnproven: true } : { ...next, cleanupUnproven: true });
    };

    const groupHasNoLiveMember = (pgid: number): boolean => {
      try {
        return probeGroup(pgid) === 'no-live-members';
      } catch {
        // A probe that throws proves nothing, so the group counts as live.
        return false;
      }
    };

    const signalGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0) return;
      try {
        process.kill(-pid, signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // ESRCH proves the group already exited. Darwin answers EPERM when every member left is
        // an unreaped zombie, so EPERM keeps the outcome only when the group has no live member.
        // Any other answer, or a probe that throws, leaves cleanup unproven.
        if (code === 'ESRCH' || (code === 'EPERM' && groupHasNoLiveMember(pid))) return;
        cleanupUnproven = true;
      }
    };

    const beginCleanup = (next: McpOutcome): void => {
      if (outcome === null) outcome = next;
      if (cleanupStarted) return;
      cleanupStarted = true;
      clearTimeout(deadline);
      signalGroup(SIGNAL.TERM);
      forceKill = setTimeout(() => {
        signalGroup(SIGNAL.KILL);
        // A child-process error normally has a matching close event. If a host
        // breaks that contract, report the bounded outcome after the whole-group
        // kill rather than leaving the registry call pending forever.
        cleanupDeadline = setTimeout(() => settle(outcome ?? { kind: 'child_exit' }), TERMINATION_GRACE_MS);
      }, TERMINATION_GRACE_MS);
      forceKill.unref?.();
    };

    const write = (message: Record<string, unknown>): boolean => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch {
        beginCleanup({ kind: 'protocol_error' });
        return false;
      }
    };

    const beginRequest = (): void => {
      if (!write({ jsonrpc: '2.0', method: 'notifications/initialized' })) return;
      write({ jsonrpc: '2.0', id: 2, method, params });
    };

    const handleMessage = (message: unknown): void => {
      if (!isRecord(message)) {
        beginCleanup({ kind: 'protocol_error' });
        return;
      }
      if (message['id'] === 1) {
        if (initialized || !isRecord(message['result']) || !isRecord(message['result']['serverInfo'])) {
          beginCleanup({ kind: 'protocol_error' });
          return;
        }
        initialized = true;
        beginRequest();
        return;
      }
      if (message['id'] === 2) {
        if (!initialized || Object.prototype.hasOwnProperty.call(message, 'error') || !Object.prototype.hasOwnProperty.call(message, 'result')) {
          beginCleanup({ kind: 'protocol_error' });
          return;
        }
        beginCleanup({ kind: 'result', result: message['result'] });
      }
    };

    const consumeStdout = (chunk: Buffer): void => {
      if (cleanupStarted) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        beginCleanup({ kind: 'output_limit' });
        return;
      }
      stdoutBuffer += stdoutDecoder.write(chunk);
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (cleanupStarted || line.trim().length === 0) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          beginCleanup({ kind: 'protocol_error' });
          return;
        }
      }
    };

    const consumeStderr = (chunk: Buffer): void => {
      if (cleanupStarted) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxStderrBytes) beginCleanup({ kind: 'output_limit' });
    };

    try {
      child = spawn(launch.command, launch.args, {
        detached: true,
        env: childEnvironment(launch.env, authority),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      settle({ kind: 'spawn_error' });
      return;
    }

    deadline = setTimeout(() => beginCleanup({ kind: 'timeout' }), timeoutMs);
    deadline.unref?.();
    child.stdout?.on('data', consumeStdout);
    child.stderr?.on('data', consumeStderr);
    child.stdin?.on('error', () => beginCleanup({ kind: 'protocol_error' }));
    child.on('error', () => beginCleanup({ kind: 'spawn_error' }));
    child.on('close', () => {
      signalGroup(SIGNAL.KILL);
      settle(outcome ?? { kind: 'child_exit' });
    });

    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'whatsoup-microsoft365-adapter', version: '1.0.0' },
      },
    });
  });
}

function errorFor(outcome: Exclude<RequestOutcome, { kind: 'result' }>): ReturnType<typeof toolError> {
  if (outcome.kind === 'launch_refused') {
    return toolError({ error: 'microsoft365_authority_unavailable', message: 'Microsoft 365 authority is unavailable for this chat.' });
  }
  const error = outcome.kind === 'timeout'
    ? 'microsoft365_timeout'
    : outcome.kind === 'output_limit'
      ? 'microsoft365_output_limit'
      : outcome.kind === 'protocol_error'
        ? 'microsoft365_protocol_error'
        : outcome.kind === 'spawn_error'
          ? 'microsoft365_spawn_error'
          : 'microsoft365_child_exit';
  return toolError({
    error,
    message: 'Microsoft 365 MCP request did not complete.',
    ...(outcome.cleanupUnproven ? { cleanup: 'unproven' } : {}),
  });
}

function validCatalogue(outcome: RequestOutcome): RequestOutcome {
  if (outcome.kind !== 'result' || !isRecord(outcome.result) || !Array.isArray(outcome.result['tools'])) {
    return outcome.kind === 'result' ? { kind: 'protocol_error' } : outcome;
  }
  return outcome;
}

/**
 * Creates the single provider-independent Microsoft 365 executor. Every tool
 * call uses the configured account-bound plugin; models and credentials are not
 * selectable through this surface.
 */
export function createMicrosoft365Tool(options: Microsoft365ToolOptions): ToolDeclaration {
  const launch = validateLaunch(options.launch);
  const timeoutMs = validatedPositiveOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'timeoutMs');
  const maxStdoutBytes = validatedPositiveOption(options.maxStdoutBytes, DEFAULT_STDOUT_LIMIT_BYTES, MAX_CAPTURE_BYTES, 'maxStdoutBytes');
  const maxStderrBytes = validatedPositiveOption(options.maxStderrBytes, DEFAULT_STDERR_LIMIT_BYTES, MAX_CAPTURE_BYTES, 'maxStderrBytes');
  const probeGroup = options.probeGroup ?? ((pgid: number) => probeGroupMembership(pgid, GROUP_PROBE_TIMEOUT_MS));
  if (typeof options.launchAllowed !== 'function') {
    throw new TypeError('Microsoft 365 launchAllowed must be a function');
  }
  const launchAllowed = options.launchAllowed;
  const cacheKey = catalogueCacheKey(launch);

  const authorityFor = async (session: SessionContext): Promise<Microsoft365Authority | ReturnType<typeof toolError>> => {
    const timedOut = Symbol('microsoft365-authority-timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = Promise.resolve().then(() => options.authorityForSession(session));
      const authority = await Promise.race([
        pending,
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (authority === timedOut) {
        // A late authority is never used, so its token is retired as soon as it arrives.
        void pending.then((late) => late?.release?.(), () => undefined);
        return toolError({
          error: 'microsoft365_authority_timeout',
          message: 'Microsoft 365 authority did not become available before the request deadline.',
        });
      }
      const socketPath = requireAbsoluteSocket(authority?.socketPath);
      if (
        socketPath === null
        || !nonEmptyEnvironmentValue(authority?.sessionToken)
        || !nonEmptyEnvironmentValue(authority?.accountId)
      ) {
        authority?.release?.();
        return toolError({ error: 'microsoft365_authority_unavailable', message: 'Microsoft 365 authority is unavailable for this chat.' });
      }
      if (authority.accountId !== launch.accountId) {
        authority.release?.();
        return toolError({
          error: 'microsoft365_account_mismatch',
          message: 'Microsoft 365 account binding does not match this chat\'s authorized account.',
        });
      }
      return { socketPath, sessionToken: authority.sessionToken, accountId: authority.accountId, release: authority.release };
    } catch {
      return toolError({ error: 'microsoft365_authority_unavailable', message: 'Microsoft 365 authority is unavailable for this chat.' });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    name: 'microsoft365',
    description: 'Use the configured Microsoft 365 account. List available operations or call one with its documented arguments.',
    schema: z.object({
      operation: z.enum(['list', 'call']),
      name: z.string().min(1).optional(),
      args: z.record(z.unknown()).optional(),
    }).superRefine((value, context) => {
      if (value.operation === 'call' && value.name === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['name'], message: 'name is required when operation is call' });
      }
    }),
    scope: 'chat',
    // Authority resolves only from a chat-scoped session's own turn, so other sessions never see it.
    chatSessionsOnly: true,
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    core: false,
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'external' },
    handler: async (params, session) => {
      const operation = params['operation'];
      if (operation === 'list') {
        const authority = await authorityFor(session);
        if (!isMicrosoft365Authority(authority)) return authority;
        try {
          let catalogue = cataloguesByAccountAndVersion.get(cacheKey);
          if (catalogue === undefined) {
            catalogue = requestMcp(
              launch,
              authority,
              'tools/list',
              {},
              timeoutMs,
              maxStdoutBytes,
              maxStderrBytes,
              probeGroup,
              launchAllowed,
            ).then(validCatalogue);
            cataloguesByAccountAndVersion.set(cacheKey, catalogue);
          }
          const outcome = await catalogue;
          if (outcome.kind !== 'result') {
            cataloguesByAccountAndVersion.delete(cacheKey);
            return errorFor(outcome);
          }
          return { tools: (outcome.result as Record<string, unknown>)['tools'] };
        } finally {
          authority.release?.();
        }
      }

      const name = params['name'];
      if (operation !== 'call' || typeof name !== 'string' || name.length === 0) {
        return toolError({ error: 'microsoft365_invalid_request', message: 'Microsoft 365 calls require an operation name.' });
      }
      // The authority binds one account; an operation that switches account or environment is never forwarded.
      if (M365_ACCOUNT_SELECTION_TOOLS.includes(name.trim().toLowerCase())) {
        return toolError({ error: 'microsoft365_invalid_request', message: 'Microsoft 365 calls must not select an account or environment.' });
      }
      const args = params['args'];
      if (args !== undefined && !isRecord(args)) {
        return toolError({ error: 'microsoft365_invalid_request', message: 'Microsoft 365 call arguments must be an object.' });
      }
      // The plugin derives its own durable operation keys; a caller may never supply one.
      if (args !== undefined && Object.keys(args).some((key) => key.startsWith('_agent365_'))) {
        return toolError({ error: 'microsoft365_invalid_request', message: 'Microsoft 365 call arguments must not use reserved _agent365_ keys.' });
      }
      const authority = await authorityFor(session);
      if (!isMicrosoft365Authority(authority)) return authority;
      let outcome: RequestOutcome;
      try {
        // requestMcp settles only after the child closed and its process group was killed.
        outcome = await requestMcp(
          launch,
          authority,
          'tools/call',
          { name, arguments: args ?? {} },
          timeoutMs,
          maxStdoutBytes,
          maxStderrBytes,
          probeGroup,
          launchAllowed,
        );
      } finally {
        authority.release?.();
      }
      if (outcome.kind !== 'result') return errorFor(outcome);
      if (isRecord(outcome.result) && outcome.result['isError'] === true) {
        return toolError({ error: 'microsoft365_tool_error', message: 'Microsoft 365 reported a tool error.' });
      }
      return outcome.result;
    },
  };
}
