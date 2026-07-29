import type { Database } from './database.ts';
import type { ToolDurabilityTelemetrySnapshot } from './durability-evidence-contract.ts';

export interface OutboundSendHealth {
  readable: boolean;
  total: number | null;
  intent: number | null;
  submitted: number | null;
  confirmed: number | null;
  failed_not_sent: number | null;
  ambiguous: number | null;
  legacy_unclassified: number | null;
  latest_successful_send_at: string | null;
}

export interface ToolDurabilityHealth {
  readable: boolean;
  total: number | null;
  open: number | null;
  terminal: number | null;
  failures: number | null;
  legacy_unclassified: number | null;
  runtime_write_losses: ToolDurabilityTelemetrySnapshot | null;
}

export function unreadableOutboundSendHealth(): OutboundSendHealth {
  return {
    readable: false,
    total: null,
    intent: null,
    submitted: null,
    confirmed: null,
    failed_not_sent: null,
    ambiguous: null,
    legacy_unclassified: null,
    latest_successful_send_at: null,
  };
}

export function readOutboundSendHealth(db: Database): OutboundSendHealth {
  const row = db.raw.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN outcome_code = 'intent' THEN 1 ELSE 0 END) AS intent,
      SUM(CASE WHEN outcome_code = 'submitted' THEN 1 ELSE 0 END) AS submitted,
      SUM(CASE WHEN outcome_code = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN outcome_code = 'failed_not_sent' THEN 1 ELSE 0 END) AS failed_not_sent,
      SUM(CASE WHEN outcome_code = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
      SUM(CASE WHEN outcome_code = 'legacy_unclassified' THEN 1 ELSE 0 END) AS legacy_unclassified,
      MAX(CASE
        WHEN outcome_code IN ('submitted', 'confirmed') THEN completed_at
        ELSE NULL
      END) AS latest_successful_send_at
    FROM outbound_sends
  `).get() as Omit<OutboundSendHealth, 'readable'> | undefined;
  return {
    readable: true,
    total: row?.total ?? 0,
    intent: row?.intent ?? 0,
    submitted: row?.submitted ?? 0,
    confirmed: row?.confirmed ?? 0,
    failed_not_sent: row?.failed_not_sent ?? 0,
    ambiguous: row?.ambiguous ?? 0,
    legacy_unclassified: row?.legacy_unclassified ?? 0,
    latest_successful_send_at: row?.latest_successful_send_at ?? null,
  };
}

export function unreadableToolDurabilityHealth(
  runtimeWriteLosses: ToolDurabilityTelemetrySnapshot | null,
): ToolDurabilityHealth {
  return {
    readable: false,
    total: null,
    open: null,
    terminal: null,
    failures: null,
    legacy_unclassified: null,
    runtime_write_losses: runtimeWriteLosses,
  };
}

export function readToolDurabilityHealth(
  db: Database,
  runtimeWriteLosses: ToolDurabilityTelemetrySnapshot | null,
): ToolDurabilityHealth {
  const row = db.raw.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN outcome_code = 'not_terminal' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN outcome_code <> 'not_terminal' THEN 1 ELSE 0 END) AS terminal,
      SUM(CASE WHEN outcome_code = 'failure' THEN 1 ELSE 0 END) AS failures,
      SUM(CASE WHEN evidence_coverage = 'legacy_unclassified' THEN 1 ELSE 0 END) AS legacy_unclassified
    FROM tool_calls
  `).get() as Omit<ToolDurabilityHealth, 'readable' | 'runtime_write_losses'> | undefined;
  return {
    readable: true,
    total: row?.total ?? 0,
    open: row?.open ?? 0,
    terminal: row?.terminal ?? 0,
    failures: row?.failures ?? 0,
    legacy_unclassified: row?.legacy_unclassified ?? 0,
    runtime_write_losses: runtimeWriteLosses,
  };
}
