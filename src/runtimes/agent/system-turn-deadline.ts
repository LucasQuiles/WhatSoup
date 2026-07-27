import { createChildLogger } from '../../logger.ts';
import type {
  PendingSystemResultTracker,
  PendingSystemTurnOwner,
  SystemTurnLeaseToken,
  SystemTurnPurpose,
} from './pending-system-result-tracker.ts';

const log = createChildLogger('system-turn-deadline');

export interface DeferredSystemTurnParams {
  tracker: PendingSystemResultTracker;
  scopeKey: string;
  purpose: SystemTurnPurpose;
  owner: PendingSystemTurnOwner;
  routeChatJid?: string;
  timeoutMs: number;
  quarantine: (lease: SystemTurnLeaseToken) => Promise<boolean>;
}

export function markDeferredSystemTurn(params: DeferredSystemTurnParams): SystemTurnLeaseToken {
  let retryWindowGranted = false;
  return params.tracker.mark({
    scopeKey: params.scopeKey,
    purpose: params.purpose,
    owner: params.owner,
    ...(params.routeChatJid !== undefined ? { routeChatJid: params.routeChatJid } : {}),
    ...(params.purpose === 'auto_compact_silent'
      ? {}
      : {
          timeoutMs: params.timeoutMs,
          deferDeadlineUntilActivated: true,
          onTimeout: async (lease: SystemTurnLeaseToken): Promise<boolean | 'retry'> => {
            if (!retryWindowGranted) {
              retryWindowGranted = true;
              log.warn(
                { scopeKey: params.scopeKey, leaseId: lease.id, purpose: params.purpose, timeoutMs: params.timeoutMs },
                'system provider request timed out — retrying once before quarantine',
              );
              return 'retry';
            }
            log.error(
              { scopeKey: params.scopeKey, leaseId: lease.id, purpose: params.purpose, timeoutMs: params.timeoutMs },
              'system provider request timed out — quarantining source generation',
            );
            return params.quarantine(lease);
          },
        }),
  });
}

export function requireSystemTurnProviderBoundary(
  tracker: PendingSystemResultTracker,
  lease: SystemTurnLeaseToken,
): void {
  if (tracker.activateDeadline(lease)) return;
  throw new Error(`SYSTEM_TURN_LEASE_NOT_LIVE_AT_PROVIDER_BOUNDARY:${lease.id}`);
}
