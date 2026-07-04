import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal fail-closed route-event sidecar (slice-2 B3; the full event
 * taxonomy + DelegationReceipt land in slice 4).
 *
 * Contract: append-only per-instance NDJSON; events carry route metadata
 * ONLY — never message bodies and never raw sender JIDs (conversationKey is
 * the runtime's internal chat identity; the file lives inside the trusted
 * per-instance boundary). Emit failure degrades to a warning and must never
 * block or delay a turn.
 */

export interface ModelRouteEvent {
  ts: number;
  event: 'runtime_selected' | 'model_preference_set' | 'model_preference_cleared' | 'user_pin_unreachable';
  instance: string;
  conversationKey: string;
  provider: string;
  modelRef: string | null;
  source: 'default' | 'user' | 'auto_fallback';
  reasonCode: string;
}

export function emitRouteEvent(
  dir: string,
  ev: ModelRouteEvent,
  warn: (msg: string) => void,
): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'route-events.ndjson'), JSON.stringify(ev) + '\n');
  } catch (err) {
    // Fail-closed for the TURN, not the evidence: a broken sink loses one
    // event line, never a user reply.
    warn(`route-event emit failed: ${String(err)}`);
  }
}
