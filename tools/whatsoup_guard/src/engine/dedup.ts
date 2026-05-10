import { dedupWindowMs, severityRank } from './severity.ts';
import type { Severity } from '../types.ts';

export interface PreviousAlert {
  ts: number;
  severity: Severity;
  fingerprint: string;
}

export interface DedupInput {
  now: number;
  severity: Severity;
  fingerprint: string;
  previousAlert: PreviousAlert | undefined;
  dedupAllowed?: boolean;
}

export interface DedupResult {
  suppress: boolean;
  reason?: string;
}

export function dedupSuppresses(input: DedupInput): DedupResult {
  const { now, severity, fingerprint, previousAlert, dedupAllowed = true } = input;

  if (!dedupAllowed) {
    return { suppress: false, reason: 'dedup disabled for event' };
  }

  if (!previousAlert) {
    return { suppress: false };
  }

  if (previousAlert.fingerprint !== fingerprint) {
    return { suppress: false, reason: 'fingerprint changed' };
  }

  if (severityRank(severity) > severityRank(previousAlert.severity)) {
    return { suppress: false, reason: 'severity escalated' };
  }

  const windowMs = dedupWindowMs(severity);
  if (windowMs === 0) {
    return { suppress: false, reason: 'severity has no dedup window' };
  }

  const elapsedMs = now - previousAlert.ts;
  if (elapsedMs < 0) {
    return { suppress: false, reason: 'previous alert is in the future' };
  }

  if (elapsedMs >= windowMs) {
    return { suppress: false, reason: 'dedup window expired' };
  }

  return { suppress: true, reason: `within dedup window (${windowMs} ms)` };
}
