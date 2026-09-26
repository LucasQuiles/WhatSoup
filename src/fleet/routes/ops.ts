/**
 * Fleet ops API: the shared `OpsDeps` contract plus a re-export shim.
 *
 * The handlers live in per-concern modules (#2239):
 *   - ops-auth.ts       SSE auth stream and pairing routes
 *   - ops-config.ts     PATCH config persistence and its validation helpers
 *   - ops-lifecycle.ts  restart, stop, delete and create
 *   - ops-messages.ts   send, access update, mark-read and save contact
 *
 * Existing callers and tests import from this file, so every handler is
 * re-exported here unchanged. `tests/scripts/ops-routes-size.test.ts` keeps it
 * below 200 lines; new handler code belongs in the module that owns it.
 */
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetRealtimePublisher } from '../realtime-publisher.ts';
import type { ServiceManager } from '../platform.ts';

export interface OpsDeps {
  discovery: FleetDiscovery;
  realtime: FleetRealtimePublisher;
  serviceManager: ServiceManager;
}

// Message handlers (send, access update, mark-read, save contact) extracted to
// ./ops-messages.ts (#2239). Re-exported here as a migration shim so existing
// callers and tests are unchanged.
export { handleSend, handleAccessUpdate, handleMarkRead, handleSaveContact } from './ops-messages.ts';

// handleAuth + its module-level auth-session state (activeAuthProcesses,
// authInFlight) extracted to ./ops-auth.ts (#2239). Re-exported here as a
// migration shim so existing callers and tests are unchanged; follow-up
// slices update imports to point at ops-auth.ts directly.
export { handleAuth } from './ops-auth.ts';

// handleConfigUpdate (PATCH /api/lines/:name/config, including the
// enabledPlugins write to both config.json and the agent's settings.json) and
// its validation helpers extracted to ./ops-config.ts (#2239). Re-exported here
// as a migration shim so existing callers and tests are unchanged.
export { handleConfigUpdate } from './ops-config.ts';

// Service-lifecycle handlers (restart, stop, delete, create) extracted to
// ./ops-lifecycle.ts (#2239). Re-exported here as a migration shim so existing
// callers and tests are unchanged.
export { handleRestart, handleStop, handleDeleteLine, handleCreateLine } from './ops-lifecycle.ts';
