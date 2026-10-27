import { createHmac, timingSafeEqual } from 'node:crypto';
import { isNonEmptyString, isRecord } from '../lib/type-guards.ts';

export const M365_PLUGIN_KEY = 'microsoft_365@microsoft-365-dev';
export const M365_USER_FULL_PROFILE = 'user-full-v1';
const M365_TENANT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface M365BridgeBinding {
  tenantId: string;
  accountId?: string;
  accountEmail?: string;
  origin: string;
  profile: typeof M365_USER_FULL_PROFILE;
}

export type M365MutationPolicy =
  | { status: 'approved'; childEnv: NodeJS.ProcessEnv }
  | { status: 'rejected' };

export interface ResolveM365MutationPolicyOptions {
  instanceName?: string;
  provider?: string;
  allowM365Mutations?: boolean;
  enabledPlugins?: Record<string, boolean>;
  binding?: M365BridgeBinding;
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
  | { kind: 'account-email' };

interface M365MutationPrerequisites {
  binding: M365BridgeBinding;
  env: NodeJS.ProcessEnv;
  origin: string;
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
  const allowedKeys = new Set(['tenantId', 'accountId', 'accountEmail', 'origin', 'profile']);
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
  return null;
}

function hasBoundSelector(binding: M365BridgeBinding, env: NodeJS.ProcessEnv): boolean {
  const bindingSelectors = [binding.accountId, binding.accountEmail].filter(nonBlank);
  const serviceSelectors = [env.MS365_AGENT365_ACCOUNT_ID, env.MS365_AGENT365_ACCOUNT_EMAIL].filter(nonBlank);
  if (bindingSelectors.length !== 1 || serviceSelectors.length !== 1) return false;
  if (binding.accountId) return env.MS365_AGENT365_ACCOUNT_ID === binding.accountId && env.MS365_AGENT365_ACCOUNT_EMAIL === undefined;
  return env.MS365_AGENT365_ACCOUNT_EMAIL === binding.accountEmail && env.MS365_AGENT365_ACCOUNT_ID === undefined;
}

/**
 * Resolves the common, non-secret part of M365 mutation admission. The deploy
 * wrapper uses this same decision before it projects the instance-bound credential;
 * runtime admission then requires the process-bound credential admission below.
 */
function m365MutationPrerequisites(
  options: ResolveM365MutationPolicyOptions,
): M365MutationPrerequisites | null {
  const binding = options.binding;
  if (!binding) return null;
  if (validateM365BridgeBinding(binding) !== null) return null;

  // env-allowed: bridge admission compares injected service credentials at the call boundary.
  const env = options.env ?? process.env;
  const origin = exactLoopbackOrigin(binding.origin);
  const serviceBaseOrigin = exactLoopbackOrigin(env.MS365_AGENT365_BASE_URL);
  const serviceHubOrigin = exactLoopbackOrigin(env.MS365_HUB_URL);
  const approved =
    options.provider === 'claude-cli' &&
    options.allowM365Mutations === true &&
    options.enabledPlugins?.[M365_PLUGIN_KEY] === true &&
    binding.profile === M365_USER_FULL_PROFILE &&
    isConcreteM365TenantId(binding.tenantId) &&
    env.ALLOW_M365_MUTATIONS === '1' &&
    env.MS365_AGENT365_BRIDGE === 'true' &&
    env.MS365_TENANT_ID === binding.tenantId &&
    env.MS365_PROFILE === M365_USER_FULL_PROFILE &&
    origin !== null &&
    serviceBaseOrigin === origin &&
    serviceHubOrigin === origin &&
    hasBoundSelector(binding, env);

  return approved ? { binding, env, origin } : null;
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
  instanceName: string | undefined,
  processId: number,
): string | null {
  const { binding, env, origin } = prerequisites;
  const key = env.MS365_AGENT365_API_KEY;
  if (!nonBlank(instanceName) || !Number.isSafeInteger(processId) || processId <= 0 || !nonBlank(key)) return null;
  return createHmac('sha256', key).update(JSON.stringify([
    'whatsoup-m365-launch-v1', processId, instanceName, binding.tenantId,
    binding.accountId ?? null, binding.accountEmail ?? null, origin, binding.profile,
  ])).digest('hex');
}

/** Bind a resolved credential to the wrapper process that will exec the runtime. */
export function m365BridgeCredentialAdmission(
  options: ResolveM365MutationPolicyOptions,
  processId: number,
): string | null {
  const prerequisites = m365MutationPrerequisites(options);
  return prerequisites ? credentialAdmission(prerequisites, options.instanceName, processId) : null;
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
  if (!prerequisites) return { status: 'rejected' };
  const admission = credentialAdmission(prerequisites, options.instanceName, process.pid);
  const supplied = prerequisites.env.WHATSOUP_M365_LAUNCH_ADMISSION;
  // An old/direct launcher cannot authorize ambient credentials; an inherited
  // admission from another process or a changed binding/key cannot be replayed.
  if (admission === null || !nonBlank(supplied) || !/^[0-9a-f]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(admission, 'hex'))) return { status: 'rejected' };
  const { binding, env, origin } = prerequisites;

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
  ]) as NodeJS.ProcessEnv;

  return { status: 'approved', childEnv };
}

export function m365MutationExceptionAllowed(policy: M365MutationPolicy | undefined): boolean {
  return policy?.status === 'approved';
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
  if (opts['provider'] !== 'claude-cli') {
    return { field: 'agentOptions.m365Bridge', message: 'agentOptions.m365Bridge requires agentOptions.provider to be claude-cli' };
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
