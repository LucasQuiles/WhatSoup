export const PROVIDER_DATA_POLICIES = ['trusted', 'restricted'] as const;
export type ProviderDataPolicy = (typeof PROVIDER_DATA_POLICIES)[number];

export const PROVIDER_BOUNDARY_MODES = ['shadow', 'enforce'] as const;
export type ProviderBoundaryMode = (typeof PROVIDER_BOUNDARY_MODES)[number];

export const PROVIDER_DATA_POLICY_VERSION = 'provider-data-policy-v1' as const;
export type ProviderDataPolicyVersion = typeof PROVIDER_DATA_POLICY_VERSION;
export type ProviderDataPolicyState = 'classified' | 'missing' | 'unsupported';

export interface ProviderRoutePolicy {
  readonly provider: string;
  readonly model: string | undefined;
  readonly dataPolicy: ProviderDataPolicy | null;
  readonly policyVersion: ProviderDataPolicyVersion;
  readonly policyState: ProviderDataPolicyState;
}

export interface ProviderCheckpointRoutePolicy {
  provider: unknown;
  model: unknown;
  dataPolicy: unknown;
  policyVersion: unknown;
}

export class ProviderDataPolicyError extends Error {
  readonly code: 'missing_policy' | 'unsupported_policy' | 'checkpoint_policy_mismatch';
  readonly provider: string;
  readonly model: string | undefined;

  constructor(
    code: ProviderDataPolicyError['code'],
    message: string,
    route: { provider: string; model: string | undefined },
  ) {
    super(message);
    this.name = 'ProviderDataPolicyError';
    this.code = code;
    this.provider = route.provider;
    this.model = route.model;
  }
}

export function isProviderDataPolicy(value: unknown): value is ProviderDataPolicy {
  return typeof value === 'string'
    && (PROVIDER_DATA_POLICIES as readonly string[]).includes(value);
}

export function isProviderBoundaryMode(value: unknown): value is ProviderBoundaryMode {
  return typeof value === 'string'
    && (PROVIDER_BOUNDARY_MODES as readonly string[]).includes(value);
}

export function isRestrictedProviderSupported(provider: string): boolean {
  return provider === 'openai-api' || provider === 'anthropic-api';
}

export function providerRoutePolicyKey(provider: string, model: string | undefined): string {
  return JSON.stringify([provider, model ?? null]);
}

export function resolveProviderRoutePolicy(input: {
  provider: string;
  model: string | undefined;
  dataPolicy: ProviderDataPolicy | null | undefined;
  boundaryMode: ProviderBoundaryMode;
}): ProviderRoutePolicy {
  const dataPolicy = input.dataPolicy ?? null;
  let policyState: ProviderDataPolicyState = 'classified';
  if (dataPolicy === null) policyState = 'missing';
  else if (dataPolicy === 'restricted' && !isRestrictedProviderSupported(input.provider)) {
    policyState = 'unsupported';
  }

  if (input.boundaryMode === 'enforce' && policyState !== 'classified') {
    const detail = policyState === 'missing'
      ? 'has no explicit provider data policy'
      : 'cannot use restricted policy without a proven mechanical isolation boundary';
    throw new ProviderDataPolicyError(
      policyState === 'missing' ? 'missing_policy' : 'unsupported_policy',
      `Provider route ${input.provider}/${input.model ?? '<default>'} ${detail}`,
      input,
    );
  }

  return Object.freeze({
    provider: input.provider,
    model: input.model,
    dataPolicy,
    policyVersion: PROVIDER_DATA_POLICY_VERSION,
    policyState,
  });
}

export function assertCheckpointRoutePolicyCompatible(
  route: ProviderRoutePolicy,
  checkpoint: ProviderCheckpointRoutePolicy | null | undefined,
): void {
  const mismatch = (message: string): never => {
    throw new ProviderDataPolicyError(
      'checkpoint_policy_mismatch',
      `Provider checkpoint ${message}`,
      route,
    );
  };
  if (!checkpoint) mismatch('is missing route policy metadata');
  const admitted = checkpoint as ProviderCheckpointRoutePolicy;
  if (admitted.provider !== route.provider) mismatch('provider mismatch');
  if (admitted.model !== (route.model ?? null)) mismatch('model mismatch');
  if (admitted.dataPolicy !== route.dataPolicy) mismatch('data policy mismatch');
  if (admitted.policyVersion !== route.policyVersion) mismatch('policy version mismatch');
}
