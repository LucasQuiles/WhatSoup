import type { Database } from '../../core/database.ts';
import { createChildLogger } from '../../logger.ts';
import {
  executionModeForProvider,
  isProviderId,
} from './providers/index.ts';
import { restoreOrphanedResidentSessionStatus } from './session-db.ts';
import type { SessionManager } from './session.ts';

const log = createChildLogger('resident-session-reconciler');

export function reconcileResidentSessionStatuses(
  db: Database,
  managers: Iterable<SessionManager>,
): Set<number> {
  const residentRowIds = new Set<number>();
  for (const manager of managers) {
    const rowId = manager.getDbRowId();
    if (rowId === null) continue;
    residentRowIds.add(rowId);

    const status = manager.getStatus();
    if (!status.active || status.durableFailureClosed || !status.sessionId) continue;

    const provider = manager.getProviderId();
    if (!isProviderId(provider)) {
      log.error({ rowId, provider }, 'resident session has an unknown provider identity');
      continue;
    }
    const persistent = executionModeForProvider(provider) === 'persistent_session';
    if (
      persistent
      && (
        status.pid === null
        || !Number.isSafeInteger(status.pid)
        || status.pid <= 0
      )
    ) {
      log.error(
        { rowId, provider, providerSessionId: status.sessionId },
        'persistent resident session has no live process identity',
      );
      continue;
    }

    try {
      const result = restoreOrphanedResidentSessionStatus(
        db,
        rowId,
        status.sessionId,
        provider,
        persistent ? status.pid! : undefined,
      );
      if (result === 'restored') {
        log.warn(
          { rowId, provider, providerSessionId: status.sessionId },
          'restored orphaned session row for authoritative current-process resident manager',
        );
      } else if (result === 'refused') {
        log.error(
          { rowId, provider, providerSessionId: status.sessionId },
          'resident session row conflicts with its authoritative checkpoint',
        );
      }
    } catch (err) {
      log.error({ err, rowId }, 'failed to reconcile current-process resident session row');
    }
  }
  return residentRowIds;
}
