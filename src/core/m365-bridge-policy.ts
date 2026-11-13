import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isNonEmptyString, isRecord } from '../lib/type-guards.ts';

export const M365_PLUGIN_KEY = 'microsoft_365@microsoft-365-dev';
export const M365_USER_FULL_PROFILE = 'user-full-v1';
const M365_TENANT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const M365_BRIDGE_PROVIDERS = new Set(['claude-cli', 'openai-api', 'anthropic-api']);

/** Providers that can expose the account-bound registry adapter. */
export function supportsM365BridgeProvider(provider: unknown): boolean {
  return isNonEmptyString(provider) && M365_BRIDGE_PROVIDERS.has(provider);
}

export interface M365BridgeBinding {
  tenantId: string;
  accountId?: string;
  accountEmail?: string;
  origin: string;
  profile: typeof M365_USER_FULL_PROFILE;
  workflowAuthority?: M365WorkflowAuthority;
}

export interface M365WorkflowAuthority {
  accountId: string;
  employeeActorJid: string;
  conversationKey?: string;
}

export type M365MutationPolicy =
  | { status: 'approved'; childEnv: NodeJS.ProcessEnv; workflowAuthority?: M365WorkflowAuthority }
  | { status: 'rejected' };

export interface ResolveM365MutationPolicyOptions {
  instanceName?: string;
  provider?: string;
  allowM365Mutations?: boolean;
  enabledPlugins?: Record<string, boolean>;
  binding?: M365BridgeBinding;
  /** `agentOptions.sessionScope`; unset means `single`, as in the runtime. Bound into the launch admission. */
  sessionScope?: M365WorkflowAuthorityScope;
  env?: NodeJS.ProcessEnv;
}

export type M365BridgeBindingValidationError =
  | { kind: 'not-object' }
  | { kind: 'unknown-keys'; keys: string[] }
  | { kind: 'tenant' }
  | { kind: 'profile' }
  | { kind: 'origin' }
  | { kind: 'selector-count' }
  | { kind: 'account-id' }
  | { kind: 'account-email' }
  | { kind: 'workflow-authority' };

interface M365MutationPrerequisites {
  binding: M365BridgeBinding;
  env: NodeJS.ProcessEnv;
  origin: string;
  durableMailStateDir: string;
}

function nonBlank(value: unknown): value is string {
  return isNonEmptyString(value) && value.trim() === value;
}

/** A bridge binding must name one directory, never an Azure directory-wide alias. */
export function isConcreteM365TenantId(value: unknown): value is string {
  return nonBlank(value) && M365_TENANT_GUID_RE.test(value);
}

export function exactLoopbackOrigin(value: unknown): string | null {
  if (!nonBlank(value)) return null;
  try {
    const url = new URL(value);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (
      url.protocol !== 'https:' ||
      !loopback ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.origin !== value
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Shared structural validation for config admission and pre-bootstrap projection. */
export function validateM365BridgeBinding(
  value: unknown,
): M365BridgeBindingValidationError | null {
  if (!isRecord(value)) return { kind: 'not-object' };
  const allowedKeys = new Set(['tenantId', 'accountId', 'accountEmail', 'origin', 'profile', 'workflowAuthority']);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) return { kind: 'unknown-keys', keys: unknownKeys };
  if (!isConcreteM365TenantId(value['tenantId'])) return { kind: 'tenant' };
  if (value['profile'] !== M365_USER_FULL_PROFILE) return { kind: 'profile' };
  if (exactLoopbackOrigin(value['origin']) === null) return { kind: 'origin' };
  const accountId = value['accountId'];
  const accountEmail = value['accountEmail'];
  if ((accountId === undefined && accountEmail === undefined) || (accountId !== undefined && accountEmail !== undefined)) {
    return { kind: 'selector-count' };
  }
  if (accountId !== undefined && !nonBlank(accountId)) return { kind: 'account-id' };
  if (accountEmail !== undefined && !nonBlank(accountEmail)) return { kind: 'account-email' };
  const workflowAuthority = value['workflowAuthority'];
  if (workflowAuthority !== undefined) {
    if (!isRecord(workflowAuthority)) return { kind: 'workflow-authority' };
    const authorityKeys = Object.keys(workflowAuthority);
    if (authorityKeys.some((key) => !['accountId', 'employeeActorJid', 'conversationKey'].includes(key))) {
      return { kind: 'workflow-authority' };
    }
    // The broker compares the employee with the canonical executing actor, which is always a phone JID.
    if (!nonBlank(workflowAuthority['accountId']) || !/^\d+@s\.whatsapp\.net$/.test(String(workflowAuthority['employeeActorJid'])) ||
        (workflowAuthority['conversationKey'] !== undefined && !nonBlank(workflowAuthority['conversationKey'])) ||
        accountId !== workflowAuthority['accountId']) return { kind: 'workflow-authority' };
  }
  return null;
}

function hasBoundSelector(binding: M365BridgeBinding, env: NodeJS.ProcessEnv): boolean {
  const bindingSelectors = [binding.accountId, binding.accountEmail].filter(nonBlank);
  const serviceSelectors = [env.MS365_AGENT365_ACCOUNT_ID, env.MS365_AGENT365_ACCOUNT_EMAIL].filter(nonBlank);
  if (bindingSelectors.length !== 1 || serviceSelectors.length !== 1) return false;
  if (binding.accountId) return env.MS365_AGENT365_ACCOUNT_ID === binding.accountId && env.MS365_AGENT365_ACCOUNT_EMAIL === undefined;
  return env.MS365_AGENT365_ACCOUNT_EMAIL === binding.accountEmail && env.MS365_AGENT365_ACCOUNT_ID === undefined;
}

function admittedDurableMailStateDir(value: unknown): string | undefined {
  return nonBlank(value) && isAbsolute(value) && !value.includes('\0') ? value : undefined;
}

/** The setting that keeps a configured bridge from admission; a name, never a value. */
export type M365AdmissionGap =
  | 'agentOptions.m365Bridge'
  | 'MS365_DURABLE_MAIL_STATE_DIR'
  | 'agentOptions.provider'
  | 'agentOptions.allowM365Mutations'
  | 'enabledPlugins'
  | 'ALLOW_M365_MUTATIONS'
  | 'MS365_AGENT365_BRIDGE'
  | 'MS365_TENANT_ID'
  | 'MS365_PROFILE'
  | 'MS365_AGENT365_BASE_URL'
  | 'MS365_HUB_URL'
  | 'account-selector'
  | 'launch-admission';

function m365MutationAdmission(
  options: ResolveM365MutationPolicyOptions,
): { prerequisites: M365MutationPrerequisites } | { gap: M365AdmissionGap } {
  const binding = options.binding;
  if (!binding || validateM365BridgeBinding(binding) !== null) return { gap: 'agentOptions.m365Bridge' };

  // env-allowed: bridge admission compares injected service credentials at the call boundary.
  const env = options.env ?? process.env;
  const origin = exactLoopbackOrigin(binding.origin);
  const durableMailStateDir = admittedDurableMailStateDir(env.MS365_DURABLE_MAIL_STATE_DIR);
  if (origin === null) return { gap: 'agentOptions.m365Bridge' };
  if (durableMailStateDir === undefined) return { gap: 'MS365_DURABLE_MAIL_STATE_DIR' };
  // Every check must hold; the first unmet one names the setting to fix.
  const checks: ReadonlyArray<readonly [boolean, M365AdmissionGap]> = [
    [supportsM365BridgeProvider(options.provider), 'agentOptions.provider'],
    [options.allowM365Mutations === true, 'agentOptions.allowM365Mutations'],
    [options.enabledPlugins?.[M365_PLUGIN_KEY] === true, 'enabledPlugins'],
    [binding.profile === M365_USER_FULL_PROFILE && isConcreteM365TenantId(binding.tenantId), 'agentOptions.m365Bridge'],
    [env.ALLOW_M365_MUTATIONS === '1', 'ALLOW_M365_MUTATIONS'],
    [env.MS365_AGENT365_BRIDGE === 'true', 'MS365_AGENT365_BRIDGE'],
    [env.MS365_TENANT_ID === binding.tenantId, 'MS365_TENANT_ID'],
    [env.MS365_PROFILE === M365_USER_FULL_PROFILE, 'MS365_PROFILE'],
    [exactLoopbackOrigin(env.MS365_AGENT365_BASE_URL) === origin, 'MS365_AGENT365_BASE_URL'],
    [exactLoopbackOrigin(env.MS365_HUB_URL) === origin, 'MS365_HUB_URL'],
    [hasBoundSelector(binding, env), 'account-selector'],
  ];
  const unmet = checks.find(([met]) => !met);
  return unmet ? { gap: unmet[1] } : { prerequisites: { binding, env, origin, durableMailStateDir } };
}

/**
 * Resolves the common, non-secret part of M365 mutation admission. The deploy
 * wrapper uses this same decision before it projects the instance-bound credential;
 * runtime admission then requires the process-bound credential admission below.
 */
function m365MutationPrerequisites(
  options: ResolveM365MutationPolicyOptions,
): M365MutationPrerequisites | null {
  const admission = m365MutationAdmission(options);
  return 'prerequisites' in admission ? admission.prerequisites : null;
}

/**
 * The deploy-time instance credential projection has no key yet. It may run only
 * after every non-secret prerequisite for the runtime M365 decision matches.
 */
export function m365BridgeCredentialProjectionAllowed(
  options: ResolveM365MutationPolicyOptions,
): boolean {
  return m365MutationPrerequisites(options) !== null;
}

function credentialAdmission(
  prerequisites: M365MutationPrerequisites,
  options: Pick<ResolveM365MutationPolicyOptions, 'instanceName' | 'sessionScope'>,
  processId: number,
): string | null {
  const { binding, env, origin, durableMailStateDir } = prerequisites;
  const { instanceName } = options;
  const key = env.MS365_AGENT365_API_KEY;
  if (!nonBlank(instanceName) || !Number.isSafeInteger(processId) || processId <= 0 || !nonBlank(key)) return null;
  // The whole workflow assignment and the session scope it runs under are bound, so a
  // launcher admission cannot be reused after either changes.
  const authority = binding.workflowAuthority;
  return createHmac('sha256', key).update(JSON.stringify([
    'whatsoup-m365-launch-v2', processId, instanceName, binding.tenantId,
    binding.accountId ?? null, binding.accountEmail ?? null, origin, binding.profile, durableMailStateDir,
    authority ? [authority.accountId, authority.employeeActorJid, authority.conversationKey ?? null] : null,
    options.sessionScope ?? 'single',
  ])).digest('hex');
}

/** Bind a resolved credential to the wrapper process that will exec the runtime. */
export function m365BridgeCredentialAdmission(
  options: ResolveM365MutationPolicyOptions,
  processId: number,
): string | null {
  const prerequisites = m365MutationPrerequisites(options);
  return prerequisites ? credentialAdmission(prerequisites, options, processId) : null;
}

function launchAdmitted(
  prerequisites: M365MutationPrerequisites,
  options: Pick<ResolveM365MutationPolicyOptions, 'instanceName' | 'sessionScope'>,
): boolean {
  const admission = credentialAdmission(prerequisites, options, process.pid);
  const supplied = prerequisites.env.WHATSOUP_M365_LAUNCH_ADMISSION;
  // An old/direct launcher cannot authorize ambient credentials; an inherited
  // admission from another process or a changed binding/key cannot be replayed.
  return admission !== null && nonBlank(supplied) && /^[0-9a-f]{64}$/.test(supplied)
    && timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(admission, 'hex'));
}

/**
 * Names the first setting that keeps a configured bridge from runtime admission,
 * or null when it is admitted or no bridge is configured. Used for startup logs.
 */
export function m365MutationAdmissionGap(options: ResolveM365MutationPolicyOptions): M365AdmissionGap | null {
  if (!options.binding) return null;
  const admission = m365MutationAdmission(options);
  if ('gap' in admission) return admission.gap;
  return launchAdmitted(admission.prerequisites, options) ? null : 'launch-admission';
}

/**
 * Decides whether the static M365 deny exception and the bridge-only child
 * environment may be used. Undefined means no bridge was configured, so
 * callers retain their established legacy child-env behavior and deny floor.
 */
export function resolveM365MutationPolicy(
  options: ResolveM365MutationPolicyOptions,
): M365MutationPolicy | undefined {
  if (!options.binding) return undefined;
  const prerequisites = m365MutationPrerequisites(options);
  if (!prerequisites || !launchAdmitted(prerequisites, options)) return { status: 'rejected' };
  const { binding, env, origin, durableMailStateDir } = prerequisites;

  const childEnv = Object.fromEntries([
    ['ALLOW_M365_MUTATIONS', '1'],
    ['MS365_AGENT365_BRIDGE', 'true'],
    ['MS365_AGENT365_BASE_URL', origin],
    ['MS365_AGENT365_API_KEY', env.MS365_AGENT365_API_KEY],
    ...(binding.accountId ? [['MS365_AGENT365_ACCOUNT_ID', binding.accountId]] : []),
    ...(binding.accountEmail ? [['MS365_AGENT365_ACCOUNT_EMAIL', binding.accountEmail]] : []),
    ['MS365_TENANT_ID', binding.tenantId],
    ['MS365_PROFILE', M365_USER_FULL_PROFILE],
    ['MS365_HUB_URL', origin],
    ['MS365_DURABLE_MAIL_STATE_DIR', durableMailStateDir],
  ]) as NodeJS.ProcessEnv;

  // A copy per policy: a withdrawal marks this runtime's assignment object, never the configured binding.
  return { status: 'approved', childEnv, ...(binding.workflowAuthority ? { workflowAuthority: { ...binding.workflowAuthority } } : {}) };
}

export function m365MutationExceptionAllowed(policy: M365MutationPolicy | undefined): boolean {
  return policy?.status === 'approved' && policy.workflowAuthority !== undefined;
}

/**
 * The policy a native settings write uses. The M365 mutation floor is lifted only where a guarded
 * native write can succeed: `per_chat` scope without `sandboxPerChat`. Elsewhere the broker refuses
 * native writes (shared or single scope) or the child has no authority socket (sandbox, see
 * `m365SessionChildPolicy`), so a lift would serve only an unguarded copy; the assignment is
 * stripped from the settings policy there.
 */
export function m365NativeFloorPolicy(
  policy: M365MutationPolicy | undefined,
  sessionScope: M365WorkflowAuthorityScope | undefined,
  sandboxPerChat: boolean | undefined,
): M365MutationPolicy | undefined {
  if (!m365MutationExceptionAllowed(policy) || (sessionScope === 'per_chat' && sandboxPerChat !== true)) return policy;
  return policy?.status === 'approved' ? { status: 'approved', childEnv: policy.childEnv } : policy;
}

/** Session-child policies whose child gets no `MS365_WORKFLOW_AUTHORITY_SOCKET`. */
const authoritySocketWithheld = new WeakSet<M365MutationPolicy>();

/**
 * The policy a session child is spawned with. A `sandboxPerChat` child keeps the assignment, so its
 * guarded plugin still requires authority, but it gets no authority socket, so that plugin refuses
 * writes. Its `WHATSOUP_MCP_SOCKET` and session token stay: its WhatSoup proxy presents them for turn
 * replies. The settings deny floor, not a missing socket, is the native-write guard in that mode. The
 * copy keeps the assignment object, so a mid-run withdrawal still reaches it.
 */
export function m365SessionChildPolicy(policy: M365MutationPolicy | undefined, sandboxPerChat: boolean): M365MutationPolicy | undefined {
  if (!sandboxPerChat || policy?.status !== 'approved' || policy.workflowAuthority === undefined) return policy;
  const child: M365MutationPolicy = { ...policy };
  authoritySocketWithheld.add(child);
  return child;
}

export function m365AuthoritySocketWithheld(policy: M365MutationPolicy | undefined): boolean {
  return policy !== undefined && authoritySocketWithheld.has(policy);
}

/** Assignments withdrawn mid-run. A turn publishes the assignment object itself, so its readers see the withdrawal. */
const withdrawnAssignments = new WeakSet<M365WorkflowAuthority>();

/** Withdraws an assignment for the rest of the run; turns that already published it lose it at their next request. */
export function withdrawM365WorkflowAuthority(authority: M365WorkflowAuthority): void {
  withdrawnAssignments.add(authority);
}

/** False once the runtime withdrew this assignment object; the broker and the adapter read it per request. */
export function m365WorkflowAuthorityLive(authority: M365WorkflowAuthority | undefined): boolean {
  return authority !== undefined && !withdrawnAssignments.has(authority);
}

/**
 * What an executing turn publishes for the M365 broker: a human request carries its
 * request reference and the approved assignment; any other turn carries neither.
 */
/** The runtime session scope a turn ran under; the broker admits workflow authority only per chat. */
export type M365WorkflowAuthorityScope = 'per_chat' | 'shared' | 'single';

/**
 * `routePolicy` is the policy of the session that runs the turn, never the runtime-wide
 * one. A route whose policy is rejected, or whose provider cannot host the bridge,
 * publishes neither the assignment nor `m365RouteProvider`, so the adapter refuses reads
 * and writes and the broker refuses writes on it.
 */
export function m365TurnAuthority(
  routePolicy: M365MutationPolicy | undefined,
  humanRequest: boolean,
  requestRef: string | undefined,
  sessionScope?: M365WorkflowAuthorityScope,
  routeProvider?: string,
): {
  requestRef: string | undefined;
  workflowAuthority: M365WorkflowAuthority | undefined;
  workflowAuthorityScope: M365WorkflowAuthorityScope | undefined;
  m365RouteProvider: string | undefined;
} {
  const routeAdmitted = routePolicy?.status === 'approved' && supportsM365BridgeProvider(routeProvider);
  const workflowAuthority = humanRequest && routeAdmitted ? routePolicy.workflowAuthority : undefined;
  return {
    requestRef: humanRequest ? requestRef : undefined,
    workflowAuthority,
    workflowAuthorityScope: workflowAuthority !== undefined ? sessionScope : undefined,
    m365RouteProvider: routeAdmitted ? routeProvider : undefined,
  };
}

/**
 * The route policy a turn publishes: its session's snapshot narrowed by the runtime's current
 * policy, so a snapshot can lose authority but never gain it. A snapshot whose authority rested on
 * an assignment the runtime has since withdrawn is rejected outright, not merely stripped of the
 * assignment: its child may run with settings lifted at spawn, so it keeps neither reads nor writes.
 * When both carry an assignment, the current one is published: the snapshot's shape is never trusted.
 */
export function narrowM365RoutePolicy(
  snapshot: M365MutationPolicy | undefined,
  current: M365MutationPolicy | undefined,
): M365MutationPolicy | undefined {
  if (current === undefined) return undefined;
  if (snapshot?.status !== 'approved' || current.status !== 'approved') return { status: 'rejected' };
  if (!m365MutationExceptionAllowed(snapshot)) return snapshot;
  return m365MutationExceptionAllowed(current) ? current : { status: 'rejected' };
}

/**
 * The policy a route gets from the runtime policy. The primary route keeps it. The guarded plugin
 * binds writes to the employee and Microsoft account, so changing the language model need not revoke
 * that employee's request: another route on a bridge provider keeps a policy that carries the
 * assignment. Any other route is rejected.
 */
export function m365RoutePolicy(
  policy: M365MutationPolicy | undefined,
  provider: string | undefined,
  primaryRoute: boolean,
): M365MutationPolicy | undefined {
  if (policy === undefined) return undefined;
  return primaryRoute || (supportsM365BridgeProvider(provider) && m365MutationExceptionAllowed(policy)) ? policy : { status: 'rejected' };
}

export function validateM365BridgeAgentOptions(opts: Record<string, unknown>): { field: string; message: string } | null {
  if (opts['allowM365Mutations'] !== undefined && typeof opts['allowM365Mutations'] !== 'boolean') {
    return { field: 'agentOptions.allowM365Mutations', message: 'agentOptions.allowM365Mutations must be a boolean when provided' };
  }
  const rawBinding = opts['m365Bridge'];
  if (rawBinding === undefined) return null;
  const validation = validateM365BridgeBinding(rawBinding);
  if (validation?.kind === 'not-object') return { field: 'agentOptions.m365Bridge', message: 'agentOptions.m365Bridge must be an object when provided' };
  if (validation?.kind === 'unknown-keys') {
    return { field: 'agentOptions.m365Bridge', message: `agentOptions.m365Bridge has unknown key(s): ${validation.keys.join(', ')}` };
  }
  if (validation?.kind === 'tenant') return { field: 'agentOptions.m365Bridge.tenantId', message: 'agentOptions.m365Bridge.tenantId must be a concrete tenant GUID' };
  if (validation?.kind === 'profile') return { field: 'agentOptions.m365Bridge.profile', message: `agentOptions.m365Bridge.profile must be ${JSON.stringify(M365_USER_FULL_PROFILE)}` };
  if (validation?.kind === 'origin') return { field: 'agentOptions.m365Bridge.origin', message: 'agentOptions.m365Bridge.origin must be an exact https numeric loopback origin' };
  if (validation?.kind === 'selector-count') return { field: 'agentOptions.m365Bridge', message: 'agentOptions.m365Bridge requires exactly one of accountId or accountEmail' };
  if (validation?.kind === 'account-id') return { field: 'agentOptions.m365Bridge.accountId', message: 'agentOptions.m365Bridge.accountId must be a non-empty string' };
  if (validation?.kind === 'account-email') return { field: 'agentOptions.m365Bridge.accountEmail', message: 'agentOptions.m365Bridge.accountEmail must be a non-empty string' };
  if (validation?.kind === 'workflow-authority') return {
    field: 'agentOptions.m365Bridge.workflowAuthority',
    message: 'agentOptions.m365Bridge.workflowAuthority requires accountId matching m365Bridge.accountId, employeeActorJid, and an optional conversationKey restriction',
  };
  if (!supportsM365BridgeProvider(opts['provider'])) {
    return { field: 'agentOptions.m365Bridge', message: 'agentOptions.m365Bridge requires agentOptions.provider to be claude-cli, openai-api, or anthropic-api' };
  }
  if (opts['allowM365Mutations'] !== true) {
    return { field: 'agentOptions.m365Bridge', message: 'agentOptions.m365Bridge requires agentOptions.allowM365Mutations to be true' };
  }
  const enabledPlugins = opts['enabledPlugins'];
  if (!isRecord(enabledPlugins) || enabledPlugins[M365_PLUGIN_KEY] !== true) {
    return { field: 'agentOptions.m365Bridge', message: `agentOptions.m365Bridge requires enabledPlugins.${M365_PLUGIN_KEY} to be true` };
  }
  return null;
}
