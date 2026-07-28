import taxonomyJson from './fault-taxonomy-registry.json' with { type: 'json' };
import { isRecord } from './type-guards.ts';

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

export const RUNTIME_AGENT_HEALTH_SIGNAL_KINDS = Object.freeze([
  'current_gauge',
  'active_episode_count',
  'terminal_audit_count',
  'cumulative_total',
  'historical_maximum',
] as const);
export type RuntimeAgentHealthSignalKind =
  typeof RUNTIME_AGENT_HEALTH_SIGNAL_KINDS[number];

export const RUNTIME_AGENT_CURRENT_HEALTH_EFFECTS = Object.freeze([
  'positive_is_risk',
  'diagnostic_only',
] as const);
export type RuntimeAgentCurrentHealthEffect =
  typeof RUNTIME_AGENT_CURRENT_HEALTH_EFFECTS[number];

export interface RuntimeAgentHealthSignal {
  field: string;
  label: string;
  kind: RuntimeAgentHealthSignalKind;
  currentHealthEffect: RuntimeAgentCurrentHealthEffect;
  owner: string;
  test: string;
}

interface FaultTaxonomyRegistry {
  schema: 'whatsoup-fault-taxonomy-registry-v3';
  faultClasses: readonly FaultClassRegistryEntry[];
  authFailureClasses: readonly string[];
  failureDomains: {
    agentFailureClasses: FailureDomainRegistryEntry;
    providerFailureKinds: FailureDomainRegistryEntry;
    turnCapabilityErrorClasses: FailureDomainRegistryEntry;
    healthTurnErrorClasses: FailureDomainRegistryEntry;
    healthDegradationCauses: FailureDomainRegistryEntry;
    terminalAttemptFailureClasses: FailureDomainRegistryEntry;
    durableInboundFailureClasses: FailureDomainRegistryEntry;
    admissionRejectClasses: FailureDomainRegistryEntry;
    memoryOperationFailureCodes: FailureDomainRegistryEntry;
  };
  runtimeAgentHealthSignals: readonly RuntimeAgentHealthSignal[];
  terminalAttemptToInboundFailureClass: Readonly<Record<string, string>>;
  failureClassDispositions: Record<string, unknown>;
  sourceDispositions: Record<string, unknown>;
}

function assertRuntimeAgentHealthSignals(value: unknown): asserts value is RuntimeAgentHealthSignal[] {
  if (!Array.isArray(value)) throw new Error('fault taxonomy runtimeAgentHealthSignals must be a list');
  const kinds = new Set<string>(RUNTIME_AGENT_HEALTH_SIGNAL_KINDS);
  const effects = new Set<string>(RUNTIME_AGENT_CURRENT_HEALTH_EFFECTS);
  const fields = new Set<string>();
  const labels = new Set<string>();

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`fault taxonomy runtimeAgentHealthSignals[${index}] must be an object`);
    }
    const field = entry['field'];
    const label = entry['label'];
    const kind = entry['kind'];
    const effect = entry['currentHealthEffect'];
    const owner = entry['owner'];
    const test = entry['test'];
    if (typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(field)) {
      throw new Error(`fault taxonomy runtime health signal ${index} has invalid field`);
    }
    if (fields.has(field)) throw new Error(`fault taxonomy duplicate runtime health field: ${field}`);
    fields.add(field);
    if (typeof label !== 'string' || !/^runtime_agent_[a-z0-9_]+$/.test(label)) {
      throw new Error(`fault taxonomy runtime health signal ${field} has invalid label`);
    }
    if (labels.has(label)) throw new Error(`fault taxonomy duplicate runtime health label: ${label}`);
    labels.add(label);
    if (typeof kind !== 'string' || !kinds.has(kind)) {
      throw new Error(`fault taxonomy runtime health signal ${field} has unsupported kind`);
    }
    if (typeof effect !== 'string' || !effects.has(effect)) {
      throw new Error(`fault taxonomy runtime health signal ${field} has unsupported health effect`);
    }
    if (typeof owner !== 'string' || owner === '') {
      throw new Error(`fault taxonomy runtime health signal ${field} has no owner`);
    }
    if (typeof test !== 'string' || test === '') {
      throw new Error(`fault taxonomy runtime health signal ${field} has no test`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

if (taxonomyJson.schema !== 'whatsoup-fault-taxonomy-registry-v3') {
  throw new Error(`unsupported fault taxonomy schema: ${taxonomyJson.schema}`);
}
assertRuntimeAgentHealthSignals(taxonomyJson.runtimeAgentHealthSignals);

export const FAULT_TAXONOMY_REGISTRY: FaultTaxonomyRegistry = deepFreeze(
  taxonomyJson as FaultTaxonomyRegistry,
);

export const RUNTIME_AGENT_HEALTH_SIGNALS =
  FAULT_TAXONOMY_REGISTRY.runtimeAgentHealthSignals;
export const RUNTIME_AGENT_HEALTH_SIGNAL_FIELDS = Object.freeze(
  RUNTIME_AGENT_HEALTH_SIGNALS.map((entry) => entry.field),
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
