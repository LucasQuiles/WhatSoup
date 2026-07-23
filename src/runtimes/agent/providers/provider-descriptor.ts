import {
  resolveProviderCredentialState, isProviderRoutable, type ProviderCredentialState,
} from '../../../lib/provider-credential-eligibility.ts';
import { PROVIDER_IDS } from './index.ts';

export interface ProviderDescriptor {
  id: string; configured: boolean; state: ProviderCredentialState; audience: 'keyed' | 'native';
}
interface Deps { resolveState?: (p: string) => ProviderCredentialState; providerIds?: () => string[]; }

export function describeProvider(id: string, deps: Deps = {}): ProviderDescriptor {
  const state = (deps.resolveState ?? ((p) => resolveProviderCredentialState({ provider: p })))(id);
  return { id, state, configured: isProviderRoutable(state), audience: state === 'native' ? 'native' : 'keyed' };
}
export function configuredProviders(deps: Deps = {}): ProviderDescriptor[] {
  const ids = (deps.providerIds ?? (() => [...PROVIDER_IDS]))();
  return ids.map((id) => describeProvider(id, deps)).filter((d) => d.configured);
}
