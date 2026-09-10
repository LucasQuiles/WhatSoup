/**
 * Declaration-only fleet/console wire contracts for provider discovery.
 *
 * This file carries no runtime behavior. Keeping the DTOs here lets the server
 * and browser compile against one shape without making the browser traverse
 * the server composition graph.
 */

export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  type: 'cli' | 'api';
  needsApiKey: boolean;
  credentialService: string | null;
  providerConfig: string[];
}

/** Why a catalogue could not be listed. Distinct causes retain distinct
 * recovery actions and retry semantics at every consumer. */
export type ModelCatalogueUnavailableReason =
  | { kind: 'no-adapter'; harness: string }
  | {
      kind:
        | 'no-key'
        | 'key-rejected'
        | 'credential-expired'
        | 'timeout'
        | 'empty'
        | 'unparseable'
        | 'probe-failed'
        | 'lookup-failed';
    };

export type ProviderModelsListing =
  | { status: 'ok'; ids: readonly string[]; sourceLabel: string; asOfLabel: string }
  | {
      status: 'unavailable';
      reason: ModelCatalogueUnavailableReason;
      asOfLabel: string;
    };
