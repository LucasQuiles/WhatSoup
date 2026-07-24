// src/runtimes/agent/model-catalogue.ts
//
// Pure helpers for the `/model list` pickable, plain-language menu (D6/D10).
// No runtime reads, no I/O — the caller (runtime.ts) supplies the provider
// descriptors and renders the result.

import { resolveProviderKeyService, SERVICE_ENV_MAP } from '../../lib/keyring.ts';
import type { ProviderDescriptor } from './providers/provider-descriptor.ts';

/**
 * A user-facing, D7-honest line for a KEYED provider that is not configured
 * on this host — names the env var to set, NEVER a credential value. Accepts
 * either a runtime provider id (e.g. `openai-api`, resolved via
 * resolveProviderKeyService) or a bare key-service name (e.g. `openai`) that
 * is already a SERVICE_ENV_MAP key — both resolve to the same env var so this
 * is safe to call with whichever id the caller has in hand.
 *
 * Only ever called for KEYED providers (see scopedCatalogue's WHY) — a
 * native-audience provider never lands in the unconfigured bucket. If a
 * provider's env var genuinely cannot be resolved (no key-service mapping),
 * this degrades to a generic, honest line rather than fabricating a variable
 * name.
 */
export function configPointer(providerId: string): string {
  const service = resolveProviderKeyService(providerId, undefined, undefined) ?? providerId;
  const envVar = SERVICE_ENV_MAP[service];
  return envVar
    ? `${providerId} isn't configured on this host — set ${envVar} on the host to enable.`
    : `${providerId} isn't configured on this host — set its API key on the host to enable.`;
}

/**
 * Partition provider descriptors into the pickable (configured) set and the
 * unconfigured-provider ids that need a configPointer line.
 *
 * WHY this is correct without an audience check: native-audience providers
 * (codex-cli/gemini-cli, and any null-key-service provider) fail OPEN to
 * routable in the Slice-1 eligibility SSOT, so they are ALWAYS
 * `configured: true` and can never land in the unconfigured bucket.
 * Therefore every `configured === false` descriptor is necessarily a KEYED
 * provider missing its key — safe to name its env var via configPointer.
 */
export function scopedCatalogue(
  descriptors: ProviderDescriptor[],
): { pickable: ProviderDescriptor[]; configPointers: string[] } {
  const pickable: ProviderDescriptor[] = [];
  const configPointers: string[] = [];
  for (const d of descriptors) {
    if (d.configured) pickable.push(d);
    else configPointers.push(d.id);
  }
  return { pickable, configPointers };
}
