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
  return typeof value === 'string' && value.trim().length > 0 && value.trim() === value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A bridge binding must name one directory, never an Azure directory-wide alias. */
export function isConcreteM365TenantId(value: unknown): value is string {
  return nonBlank(value) && M365_TENANT_GUID_RE.test(value);
}

export function exactLoopbackOrigin(value: unknown): string | null {
  if (!nonBlank(value)) return null;
  try {
    const url = new URL(value);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (
      url.protocol !== 'http:' ||
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
  if (!record(value)) return { kind: 'not-object' };
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
 * runtime admission then adds the nonblank projected-key requirement below.
 */
function m365MutationPrerequisites(
  options: ResolveM365MutationPolicyOptions,
): M365MutationPrerequisites | null {
  const binding = options.binding;
  if (!binding) return null;
  if (validateM365BridgeBinding(binding) !== null) return null;

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
  if (!prerequisites || !nonBlank(prerequisites.env.MS365_AGENT365_API_KEY)) return { status: 'rejected' };
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
