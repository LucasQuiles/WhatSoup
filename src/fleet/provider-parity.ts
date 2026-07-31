import { lacksIndependentFallback, type AgentFallbackEntry } from '../core/fallback-chain.ts';
import { PROVIDER_IDS } from '../runtimes/agent/providers/index.ts';

export const PROVIDER_PROBE_SNAPSHOT_STATES = [
  'ok',
  'failed',
  'skipped',
  'headless_auth_inconclusive',
  'inconclusive',
] as const;

export type ProviderProbeSnapshotState = typeof PROVIDER_PROBE_SNAPSHOT_STATES[number];
export type ProviderParityExpectation = 'always_on' | 'on_demand' | 'no_bot' | 'blocked' | 'owner_deferred';
export type ProviderParityInstanceType = 'agent' | 'chat' | 'unknown';
export type ProviderParityVerdict = 'green' | 'warn' | 'blocked' | 'inconclusive' | 'not_applicable';
export type ProviderParityCredentialState = 'present' | 'missing' | 'native' | 'mixed' | 'unknown';
// Aggregate probe state derives from the per-probe snapshot domain so a new
// snapshot state cannot silently diverge: 'headless_auth_inconclusive'
// collapses to 'inconclusive' at aggregation (see providerProbeState), and
// the set-level-only states are added explicitly.
export type ProviderParityProbeState =
  | Exclude<ProviderProbeSnapshotState, 'headless_auth_inconclusive'>
  | 'not_required'
  | 'unknown';

export interface ProviderParityExpectedInstance {
  host: string;
  instance: string;
  expected: ProviderParityExpectation;
  type: ProviderParityInstanceType;
  providerProbeExpected: boolean;
}

export interface ProviderStatusSnapshot {
  primary: {
    provider: string | null;
    model: string | null;
    keyPresent: boolean | null;
  };
  fallback: {
    provider: string | null;
    model: string | null;
    keyPresent: boolean | null;
    active: boolean;
    activeUntil: number | null;
    effectiveProvider: string | null;
    recoveryProbeRequired: boolean;
    activeEntry: { provider: string; model: string | null } | null;
    chain: Array<{ provider: string; model: string | null; eligible: boolean | null }>;
  };
  signal: {
    status: string | null;
    confidence: string | null;
    reason: string | null;
    evidence: string[];
  };
  lineReachable: boolean;
}

export interface ProviderProbeSnapshot {
  host: string;
  instance: string;
  provider: string;
  state: ProviderProbeSnapshotState;
  evidenceRef?: string;
  reason?: string;
}

export interface ProviderParityInput {
  generatedAtUtc: string;
  targetMain: string;
  expected: ProviderParityExpectedInstance[];
  statuses: Record<string, ProviderStatusSnapshot | null | undefined>;
  probes?: ProviderProbeSnapshot[];
}

export interface ProviderParityRow {
  host: string;
  instance: string;
  verdict: ProviderParityVerdict;
  reasons: string[];
  primaryProvider: string | null;
  fallbackProviders: string[];
  credentialState: ProviderParityCredentialState;
  probeState: ProviderParityProbeState;
  fallbackActive: boolean;
  evidenceRefs: string[];
}

export interface ProviderParityReport {
  schema: 'provider-parity-report-v1';
  generatedAtUtc: string;
  targetMain: string;
  verdict: Exclude<ProviderParityVerdict, 'not_applicable'>;
  counts: Record<ProviderParityVerdict, number>;
  rows: ProviderParityRow[];
}

const VERDICT_SORT: Record<ProviderParityVerdict, number> = {
  blocked: 0,
  inconclusive: 1,
  warn: 2,
  green: 3,
  not_applicable: 4,
};

const API_PROVIDERS = new Set(['openai-api', 'anthropic-api']);
const KNOWN_PROVIDERS = new Set<string>(PROVIDER_IDS);

function keyFor(host: string, instance: string): string {
  return `${host}/${instance}`;
}

function isKnownProvider(provider: string | null | undefined): provider is string {
  return typeof provider === 'string' && KNOWN_PROVIDERS.has(provider);
}

function fallbackEntries(snapshot: ProviderStatusSnapshot): AgentFallbackEntry[] {
  const chain = snapshot.fallback.chain.length > 0
    ? snapshot.fallback.chain
    : snapshot.fallback.provider
      ? [{ provider: snapshot.fallback.provider, model: snapshot.fallback.model, eligible: null }]
      : [];
  return chain.map((entry) => (
    entry.model ? { provider: entry.provider, model: entry.model } : { provider: entry.provider }
  ));
}

function highestVerdict(reasons: string[]): ProviderParityVerdict {
  if (reasons.some((reason) => (
    reason.startsWith('primary_provider_unknown') ||
    reason.startsWith('fallback_provider_unknown') ||
    reason.startsWith('missing_independent_fallback') ||
    reason.startsWith('api_fallback_model_missing') ||
    reason.startsWith('credential_missing') ||
    reason.startsWith('provider_probe_failed')
  ))) {
    return 'blocked';
  }
  if (reasons.some((reason) => (
    reason.startsWith('provider_status_missing') ||
    reason.startsWith('provider_status_unreachable') ||
    reason.startsWith('provider_probe_missing') ||
    reason.startsWith('provider_probe_skipped') ||
    reason.startsWith('provider_probe_headless_auth_inconclusive') ||
    reason.startsWith('provider_probe_inconclusive') ||
    reason.startsWith('credential_unknown')
  ))) {
    return 'inconclusive';
  }
  if (reasons.length > 0) return 'warn';
  return 'green';
}

function credentialState(parts: Array<boolean | null | undefined>): ProviderParityCredentialState {
  if (parts.length === 0) return 'unknown';
  if (parts.some((part) => part === false)) return 'missing';
  if (parts.some((part) => part === undefined)) return 'unknown';
  const hasPresent = parts.some((part) => part === true);
  const hasNative = parts.some((part) => part === null);
  if (hasPresent && hasNative) return 'mixed';
  if (hasPresent) return 'present';
  return 'native';
}

function providerProbeState(probes: ProviderProbeSnapshot[]): ProviderParityProbeState {
  if (probes.length === 0) return 'unknown';
  if (probes.some((probe) => probe.state === 'failed')) return 'failed';
  if (probes.some((probe) => probe.state === 'skipped')) return 'skipped';
  if (probes.some((probe) => probe.state === 'headless_auth_inconclusive' || probe.state === 'inconclusive')) {
    return 'inconclusive';
  }
  return 'ok';
}

function evaluateProbeReasons(
  item: ProviderParityExpectedInstance,
  providers: string[],
  probes: ProviderProbeSnapshot[],
): { probeState: ProviderParityProbeState; reasons: string[]; evidenceRefs: string[] } {
  if (!item.providerProbeExpected) {
    return { probeState: 'not_required', reasons: [], evidenceRefs: [] };
  }
  const matched = probes.filter((probe) => probe.host === item.host && probe.instance === item.instance);
  const relevant = providers.length > 0
    ? matched.filter((probe) => providers.includes(probe.provider))
    : matched;
  if (relevant.length === 0) {
    return { probeState: 'unknown', reasons: ['provider_probe_missing'], evidenceRefs: [] };
  }

  const reasons: string[] = [];
  const evidenceRefs = relevant.flatMap((probe) => (probe.evidenceRef ? [probe.evidenceRef] : []));
  for (const probe of relevant) {
    if (probe.state === 'failed') reasons.push(`provider_probe_failed:${probe.provider}`);
    if (probe.state === 'skipped') reasons.push('provider_probe_skipped');
    if (probe.state === 'headless_auth_inconclusive') reasons.push('provider_probe_headless_auth_inconclusive');
    if (probe.state === 'inconclusive') reasons.push('provider_probe_inconclusive');
  }

  return {
    probeState: providerProbeState(relevant),
    reasons,
    evidenceRefs,
  };
}

// A provider-status snapshot proves the service is live when its health signal
// reports online (mirrors the `!== 'online'` degraded test at the reason stage)
// or its transport line is reachable. Either condition means the process is
// actually up, regardless of what the checked-in fleet declaration expects.
function isActiveStatus(status: ProviderStatusSnapshot | null | undefined): status is ProviderStatusSnapshot {
  if (!status) return false;
  return status.signal.status === 'online' || status.lineReachable === true;
}

function evaluateRow(
  item: ProviderParityExpectedInstance,
  status: ProviderStatusSnapshot | null | undefined,
  probes: ProviderProbeSnapshot[],
): ProviderParityRow {
  if (item.type !== 'agent' || item.expected === 'no_bot' || item.expected === 'blocked' || item.expected === 'owner_deferred') {
    // #1866: a restored agent can be active (running, transport-reachable,
    // online) while its declaration still says expected=blocked. Such a
    // service must not be silently excluded from monitoring — surface it as a
    // failing row so the post-cutover gate fails immediately instead of
    // short-circuiting to not_applicable. A genuinely blocked service (no live
    // status) stays not_applicable.
    if (item.type === 'agent' && item.expected === 'blocked' && isActiveStatus(status)) {
      return {
        host: item.host,
        instance: item.instance,
        verdict: 'blocked',
        reasons: ['restored_service_expected_blocked'],
        primaryProvider: status.primary.provider,
        fallbackProviders: [],
        credentialState: 'unknown',
        probeState: item.providerProbeExpected ? 'unknown' : 'not_required',
        fallbackActive: status.fallback.active,
        evidenceRefs: [],
      };
    }
    return {
      host: item.host,
      instance: item.instance,
      verdict: 'not_applicable',
      reasons: [],
      primaryProvider: null,
      fallbackProviders: [],
      credentialState: 'unknown',
      probeState: 'not_required',
      fallbackActive: false,
      evidenceRefs: [],
    };
  }

  if (!status) {
    return {
      host: item.host,
      instance: item.instance,
      verdict: 'inconclusive',
      reasons: ['provider_status_missing'],
      primaryProvider: null,
      fallbackProviders: [],
      credentialState: 'unknown',
      probeState: item.providerProbeExpected ? 'unknown' : 'not_required',
      fallbackActive: false,
      evidenceRefs: [],
    };
  }

  const reasons: string[] = [];
  const primaryProvider = status.primary.provider;
  const entries = fallbackEntries(status);
  const fallbackProviders = [...new Set(entries.map((entry) => entry.provider))];

  if (!isKnownProvider(primaryProvider)) reasons.push('primary_provider_unknown');
  for (const provider of fallbackProviders) {
    if (!isKnownProvider(provider)) reasons.push(`fallback_provider_unknown:${provider}`);
  }
  if (lacksIndependentFallback(primaryProvider, entries)) {
    reasons.push('missing_independent_fallback');
  }
  for (const entry of entries) {
    if (API_PROVIDERS.has(entry.provider) && !entry.model) {
      reasons.push(`api_fallback_model_missing:${entry.provider}`);
    }
  }

  const credentialParts = [status.primary.keyPresent];
  if (status.fallback.provider) credentialParts.push(status.fallback.keyPresent);
  if (status.primary.keyPresent === false && primaryProvider) reasons.push(`credential_missing:${primaryProvider}`);
  if (status.primary.keyPresent === undefined && primaryProvider) reasons.push(`credential_unknown:${primaryProvider}`);
  if (status.fallback.provider && status.fallback.keyPresent === false) {
    reasons.push(`credential_missing:${status.fallback.provider}`);
  }
  if (status.fallback.provider && status.fallback.keyPresent === undefined) {
    reasons.push(`credential_unknown:${status.fallback.provider}`);
  }

  const providerProbe = evaluateProbeReasons(item, fallbackProviders, probes);
  reasons.push(...providerProbe.reasons);
  if (!status.lineReachable) reasons.push('provider_status_unreachable');
  if (status.signal.status && status.signal.status !== 'online') reasons.push(`provider_status_${status.signal.status}`);
  if (status.fallback.active) reasons.push('fallback_active');
  if (status.fallback.recoveryProbeRequired) reasons.push('recovery_probe_required');
  for (const entry of status.fallback.chain) {
    if (entry.eligible === false) reasons.push(`fallback_entry_ineligible:${entry.provider}`);
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    host: item.host,
    instance: item.instance,
    verdict: highestVerdict(uniqueReasons),
    reasons: uniqueReasons,
    primaryProvider,
    fallbackProviders,
    credentialState: credentialState(credentialParts),
    probeState: providerProbe.probeState,
    fallbackActive: status.fallback.active,
    evidenceRefs: providerProbe.evidenceRefs,
  };
}

function reportVerdict(rows: ProviderParityRow[]): ProviderParityReport['verdict'] {
  if (rows.some((row) => row.verdict === 'blocked')) return 'blocked';
  if (rows.some((row) => row.verdict === 'inconclusive')) return 'inconclusive';
  if (rows.some((row) => row.verdict === 'warn')) return 'warn';
  return 'green';
}

export function evaluateProviderParity(input: ProviderParityInput): ProviderParityReport {
  const rows = input.expected
    .map((item) => evaluateRow(item, input.statuses[keyFor(item.host, item.instance)], input.probes ?? []))
    .sort((a, b) => (
      VERDICT_SORT[a.verdict] - VERDICT_SORT[b.verdict] ||
      a.host.localeCompare(b.host) ||
      a.instance.localeCompare(b.instance) ||
      a.reasons.join(',').localeCompare(b.reasons.join(','))
    ));

  const counts: Record<ProviderParityVerdict, number> = {
    green: 0,
    warn: 0,
    blocked: 0,
    inconclusive: 0,
    not_applicable: 0,
  };
  for (const row of rows) counts[row.verdict] += 1;

  return {
    schema: 'provider-parity-report-v1',
    generatedAtUtc: input.generatedAtUtc,
    targetMain: input.targetMain,
    verdict: reportVerdict(rows),
    counts,
    rows,
  };
}

export function exitCodeForProviderParityReport(report: ProviderParityReport): 0 | 1 {
  return report.rows.every((row) => row.verdict === 'green' || row.verdict === 'not_applicable') ? 0 : 1;
}
