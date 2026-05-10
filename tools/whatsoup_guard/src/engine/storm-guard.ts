const STORM_WINDOW_MS = 15 * 60 * 1000;

export interface StormGuardLast {
  ts: number;
  payloadHash: string;
  actionResult: string;
}

export interface StormGuardInput {
  now: number;
  lastAlert: StormGuardLast | undefined;
  payloadHash: string;
  actionResult: string;
}

export interface StormGuardResult {
  suppress: boolean;
  reason?: string;
}

export function stormGuardSuppresses(input: StormGuardInput): StormGuardResult {
  const { now, lastAlert, payloadHash, actionResult } = input;
  if (!lastAlert) {
    return { suppress: false };
  }

  const elapsedMs = now - lastAlert.ts;
  if (elapsedMs < 0) {
    return { suppress: false, reason: 'last alert is in the future' };
  }

  if (elapsedMs >= STORM_WINDOW_MS) {
    return { suppress: false, reason: 'storm window expired' };
  }

  if (lastAlert.payloadHash !== payloadHash) {
    return { suppress: false, reason: 'payload changed' };
  }

  if (lastAlert.actionResult !== actionResult) {
    return { suppress: false, reason: 'action changed' };
  }

  return { suppress: true, reason: 'identical crit within 15m window' };
}
