import taxonomyJson from './fault-taxonomy-registry.json' with { type: 'json' };

/** Named fault classes the fleet-health pipeline recognizes. Auth is the first. */
type FaultClassTuple = readonly ['auth_terminal'];
export type FaultClass = FaultClassTuple[number];

export interface FaultSignal {
  /** pino numeric level; 50 = error. */
  level: number;
  /** ops-alert source, e.g. 'provider_unknown_terminal'. */
  source?: string;
  /** structured log message signature. */
  message?: string;
}

interface FaultClassRegistryEntry {
  id: FaultClass;
  description: string;
  sources: readonly string[];
  messagePrefixes: readonly string[];
  recoveryProof: string;
  owner: string;
  tests: readonly string[];
}

interface FailureDomainRegistryEntry {
  values: readonly string[];
  owner: string;
  test: string;
}

interface FaultTaxonomyRegistry {
  schema: 'whatsoup-fault-taxonomy-registry-v2';
  faultClasses: readonly FaultClassRegistryEntry[];
  authFailureClasses: readonly string[];
  failureDomains: {
    agentFailureClasses: FailureDomainRegistryEntry;
    providerFailureKinds: FailureDomainRegistryEntry;
    turnCapabilityErrorClasses: FailureDomainRegistryEntry;
    healthTurnErrorClasses: FailureDomainRegistryEntry;
    terminalAttemptFailureClasses: FailureDomainRegistryEntry;
    durableInboundFailureClasses: FailureDomainRegistryEntry;
    admissionRejectClasses: FailureDomainRegistryEntry;
  };
  terminalAttemptToInboundFailureClass: Readonly<Record<string, string>>;
  failureClassDispositions: Record<string, unknown>;
  sourceDispositions: Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export const FAULT_TAXONOMY_REGISTRY: FaultTaxonomyRegistry = deepFreeze(
  taxonomyJson as FaultTaxonomyRegistry,
);

export const FAULT_CLASSES: FaultClassTuple = Object.freeze(
  FAULT_TAXONOMY_REGISTRY.faultClasses.map((entry) => entry.id),
) as FaultClassTuple;

const AUTH_TAXONOMY = FAULT_TAXONOMY_REGISTRY.faultClasses.find((entry) => entry.id === 'auth_terminal');
if (!AUTH_TAXONOMY) throw new Error('fault taxonomy missing auth_terminal');

/** ops-alert sources that denote a terminal auth failure. */
const AUTH_SOURCES = new Set(AUTH_TAXONOMY.sources);

/** message prefixes that denote a terminal auth failure. Matched by prefix, never substring. */
const AUTH_MESSAGE_PREFIXES = AUTH_TAXONOMY.messagePrefixes;

/**
 * Classify a structured log/alert signal into a fault class, or null.
 *
 * METRIC-INTEGRITY RULE: classification is driven ONLY by structured fields
 * (`level` + `source` + known message prefix). Bare status substrings such as
 * '401' are NEVER matched — that is the bug that produced the false multi-day
 * "storm" in the original post-mortem.
 */
export function classifyFault(signal: FaultSignal): FaultClass | null {
  if (signal.level < 50) return null;
  if (signal.source && AUTH_SOURCES.has(signal.source)) return 'auth_terminal';
  const message = signal.message ?? '';
  if (AUTH_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix))) return 'auth_terminal';
  return null;
}
