import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createChildLogger } from '../logger.ts';
import { jsonResponse, parseRoute, parseQueryString, readBody, extractBearer } from '../lib/http.ts';
import { FleetDiscovery } from './discovery.ts';
import { HealthPoller } from './health-poller.ts';
import { FleetDbReader } from './db-reader.ts';
import { createStaticHandler } from './static.ts';
import { handleGetLines, handleGetLine } from './routes/lines.ts';
import { handleGetChats, handleGetMessages, handleSearchMessages, handleGetAccess, handleGetLogs, handleGetTyping, handleCheckExists, handleCheckDirectory } from './routes/data.ts';
import { handleSend, handleAccessUpdate, handleSaveContact, handleRestart, handleStop, handleConfigUpdate, handleCreateLine, handleDeleteLine, handleAuth, handleMarkRead } from './routes/ops.ts';
import { handleGetFeed } from './routes/feed.ts';
import { handleGetMetrics } from './routes/metrics.ts';
import { handleGetFleetMetrics } from './routes/fleet-metrics.ts';
import { handleGetVersion, handleUpdate } from './routes/update.ts';
import { createServiceManager, type ServiceManager } from './platform.ts';
import {
  handleGetScheduled, handleCancelScheduled, handleGetGroups, handleSearchContacts,
  handleCreateScheduled, handleGetScheduledById, handleUpdateScheduled, handleCancelScheduledById,
  handleGetGroupDetail, handleCreateGroup, handleLeaveGroup,
  handleUpdateGroupSubject, handleUpdateGroupDescription, handleGroupParticipants,
  handleGroupSettings, handleGetGroupInvite, handleRevokeGroupInvite,
  handleGroupEphemeral, handleGroupMemberAddMode, handleGroupJoinApproval,
  handleGetGroupRequests, handleGroupRequestsUpdate,
} from './routes/mcp-proxy.ts';
import { UpdateChecker } from './update-checker.ts';
import { importLidMappings, type FleetMappingInput } from '../core/lid-resolver.ts';
import type { DatabaseSync } from 'node:sqlite';
import { FleetWebSocketServer } from './websocket-server.ts';
import type { FleetRealtimePublisher } from './realtime-publisher.ts';
import { FleetRealtimeEventPoller } from './realtime-event-poller.ts';
import {
  loadOrCreateFleetTokens as loadOrCreateFleetTokensImpl,
  verifyFleetToken as verifyFleetTokenImpl,
  type FleetTokensFile,
} from './token-storage.ts';
import { createTicketStore, TICKET_TTL_MS, type TicketStore } from './ws-ticket.ts';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const log = createChildLogger('fleet');

export interface FleetDeps {
  db: DatabaseSync;
  selfName: string;
  /**
   * Active fleet token (signs new WS tickets, accepted as Bearer).
   *
   * For rotation continuity, pass also `acceptTokens`: any prior tokens
   * that should still validate. Both shapes are accepted to keep tests and
   * callers from churning during the rollout.
   */
  fleetToken: string;
  /** Optional historic tokens still accepted (cap honored at storage layer). */
  acceptTokens?: string[];
  /** Optional request-time token source used by the standalone server after CLI rotation. */
  getFleetTokens?: () => { active: string; accept: readonly string[] };
  getSelfHealth: () => Record<string, unknown>;
}

export interface RouteDeps {
  discovery: FleetDiscovery;
  healthPoller: HealthPoller;
  dbReader: FleetDbReader;
  realtime: FleetRealtimePublisher;
  serviceManager: ServiceManager;
  log: typeof log;
  updateChecker: UpdateChecker;
}

// ---------------------------------------------------------------------------
// Handler dispatch map
// ---------------------------------------------------------------------------

type EmptyRouteParams = Record<string, never>;
type NameRouteParams = { name: string };
type NameIdRouteParams = { name: string; id: string };
type NameJidRouteParams = { name: string; jid: string };

type RouteParamsByHandler = {
  getLines: EmptyRouteParams;
  getLine: NameRouteParams;
  getChats: NameRouteParams;
  getMessages: NameRouteParams;
  searchMessages: NameRouteParams;
  getMetrics: NameRouteParams;
  getAccess: NameRouteParams;
  getLogs: NameRouteParams;
  send: NameRouteParams;
  saveContact: NameRouteParams;
  accessUpdate: NameRouteParams;
  markRead: NameRouteParams;
  restart: NameRouteParams;
  stop: NameRouteParams;
  configUpdate: NameRouteParams;
  getFleetMetrics: EmptyRouteParams;
  getTyping: EmptyRouteParams;
  getFeed: EmptyRouteParams;
  createLine: EmptyRouteParams;
  deleteLine: NameRouteParams;
  checkExists: NameRouteParams;
  checkDirectory: EmptyRouteParams;
  auth: NameRouteParams;
  getVersion: EmptyRouteParams;
  update: EmptyRouteParams;
  getLidMappings: EmptyRouteParams;
  syncLidMappings: EmptyRouteParams;
  getScheduled: NameRouteParams;
  cancelScheduled: NameRouteParams;
  getGroups: NameRouteParams;
  searchContacts: NameRouteParams;
  createScheduled: NameRouteParams;
  getScheduledById: NameIdRouteParams;
  updateScheduled: NameIdRouteParams;
  cancelScheduledById: NameIdRouteParams;
  getGroupDetail: NameJidRouteParams;
  createGroup: NameRouteParams;
  leaveGroup: NameJidRouteParams;
  updateGroupSubject: NameJidRouteParams;
  updateGroupDescription: NameJidRouteParams;
  groupParticipants: NameJidRouteParams;
  groupSettings: NameJidRouteParams;
  getGroupInvite: NameJidRouteParams;
  revokeGroupInvite: NameJidRouteParams;
  groupEphemeral: NameJidRouteParams;
  groupMemberAddMode: NameJidRouteParams;
  groupJoinApproval: NameJidRouteParams;
  getGroupRequests: NameJidRouteParams;
  groupRequestsUpdate: NameJidRouteParams;
};

type RouteKey = keyof RouteParamsByHandler;
/** Route keys whose params include at least a `name` field (NameRouteParams | NameIdRouteParams | NameJidRouteParams). */
type NamedRouteKey = {
  [K in RouteKey]: RouteParamsByHandler[K] extends { name: string } ? K : never
}[RouteKey];
type RouteHandler<K extends RouteKey> = (
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
  params: RouteParamsByHandler[K],
) => void | Promise<void>;

const EMPTY_ROUTE_PARAMS: EmptyRouteParams = {};
const NAME_ROUTE_HANDLERS = new Set<NamedRouteKey>([
  'getLine',
  'getChats',
  'getMessages',
  'searchMessages',
  'getMetrics',
  'getAccess',
  'getLogs',
  'send',
  'saveContact',
  'accessUpdate',
  'markRead',
  'restart',
  'stop',
  'configUpdate',
  'deleteLine',
  'checkExists',
  'auth',
  'getScheduled',
  'cancelScheduled',
  'getGroups',
  'searchContacts',
  'createScheduled',
  'getScheduledById',
  'updateScheduled',
  'cancelScheduledById',
  'getGroupDetail',
  'createGroup',
  'leaveGroup',
  'updateGroupSubject',
  'updateGroupDescription',
  'groupParticipants',
  'groupSettings',
  'getGroupInvite',
  'revokeGroupInvite',
  'groupEphemeral',
  'groupMemberAddMode',
  'groupJoinApproval',
  'getGroupRequests',
  'groupRequestsUpdate',
]);

function hasNameParam(handler: RouteKey): handler is NamedRouteKey {
  return NAME_ROUTE_HANDLERS.has(handler as NamedRouteKey);
}

const handlers: { [K in RouteKey]: RouteHandler<K> } = {
  getLines:     (req, res, deps, _params) => handleGetLines(req, res, deps),
  getLine:      (req, res, deps, params) => handleGetLine(req, res, deps, params),
  getChats:     (req, res, deps, params) => handleGetChats(req, res, deps, params),
  getMessages:  (req, res, deps, params) => handleGetMessages(req, res, deps, params),
  searchMessages: (req, res, deps, params) => handleSearchMessages(req, res, deps, params),
  getMetrics:     (req, res, deps, params) => handleGetMetrics(req, res, deps, params),
  getFleetMetrics: (req, res, deps, _params) => handleGetFleetMetrics(req, res, deps),
  getAccess:    (req, res, deps, params) => handleGetAccess(req, res, deps, params),
  getLogs:      (req, res, deps, params) => handleGetLogs(req, res, deps, params),
  send:         (req, res, deps, params) => handleSend(req, res, deps, params),
  saveContact:  (req, res, deps, params) => handleSaveContact(req, res, deps, params),
  accessUpdate: (req, res, deps, params) => handleAccessUpdate(req, res, deps, params),
  markRead:     (req, res, deps, params) => handleMarkRead(req, res, deps, params),
  restart:      (req, res, deps, params) => handleRestart(req, res, deps, params),
  stop:         (req, res, deps, params) => handleStop(req, res, deps, params),
  configUpdate: (req, res, deps, params) => handleConfigUpdate(req, res, deps, params),
  getTyping:    (req, res, deps, _params) => handleGetTyping(req, res, deps),
  getFeed:      (req, res, deps, _params) => handleGetFeed(req, res, deps),
  createLine:   (req, res, deps, _params) => handleCreateLine(req, res, deps),
  deleteLine:   (req, res, deps, params) => handleDeleteLine(req, res, deps, params),
  checkExists:  (req, res, deps, params) => handleCheckExists(req, res, deps, params),
  checkDirectory: (req, res) => handleCheckDirectory(req, res),
  auth:         (req, res, deps, params) => handleAuth(req, res, deps, params),
  getVersion:   (_req, res, deps, _params) => handleGetVersion(_req, res, deps.updateChecker),
  update:       (req, res, deps, _params) => handleUpdate(req, res, deps.updateChecker, repoRoot),
  getLidMappings:  (_req, res, deps, _params) => handleGetLidMappings(_req, res, deps),
  syncLidMappings: (req, res, deps, _params) => handleSyncLidMappings(req, res, deps),
  getScheduled:          (_req, res, deps, params) => handleGetScheduled(_req, res, deps, params),
  cancelScheduled:       (req, res, deps, params) => handleCancelScheduled(req, res, deps, params),
  getGroups:             (_req, res, deps, params) => handleGetGroups(_req, res, deps, params),
  searchContacts:        (req, res, deps, params) => handleSearchContacts(req, res, deps, params),
  createScheduled:       (req, res, deps, params) => handleCreateScheduled(req, res, deps, params),
  getScheduledById:      (_req, res, deps, params) => handleGetScheduledById(_req, res, deps, params),
  updateScheduled:       (req, res, deps, params) => handleUpdateScheduled(req, res, deps, params),
  cancelScheduledById:   (_req, res, deps, params) => handleCancelScheduledById(_req, res, deps, params),
  getGroupDetail:        (_req, res, deps, params) => handleGetGroupDetail(_req, res, deps, params),
  createGroup:           (req, res, deps, params) => handleCreateGroup(req, res, deps, params),
  leaveGroup:            (_req, res, deps, params) => handleLeaveGroup(_req, res, deps, params),
  updateGroupSubject:    (req, res, deps, params) => handleUpdateGroupSubject(req, res, deps, params),
  updateGroupDescription:(req, res, deps, params) => handleUpdateGroupDescription(req, res, deps, params),
  groupParticipants:     (req, res, deps, params) => handleGroupParticipants(req, res, deps, params),
  groupSettings:         (req, res, deps, params) => handleGroupSettings(req, res, deps, params),
  getGroupInvite:        (_req, res, deps, params) => handleGetGroupInvite(_req, res, deps, params),
  revokeGroupInvite:     (req, res, deps, params) => handleRevokeGroupInvite(req, res, deps, params),
  groupEphemeral:        (req, res, deps, params) => handleGroupEphemeral(req, res, deps, params),
  groupMemberAddMode:    (req, res, deps, params) => handleGroupMemberAddMode(req, res, deps, params),
  groupJoinApproval:     (req, res, deps, params) => handleGroupJoinApproval(req, res, deps, params),
  getGroupRequests:      (_req, res, deps, params) => handleGetGroupRequests(_req, res, deps, params),
  groupRequestsUpdate:   (req, res, deps, params) => handleGroupRequestsUpdate(req, res, deps, params),
};

// ---------------------------------------------------------------------------
// Fleet token management
// ---------------------------------------------------------------------------

/**
 * Load (or create) the rotatable fleet-tokens file.
 *
 * The persistence layer lives in `./token-storage.ts`. This re-export keeps the
 * public surface centralized so callers don't reach into the internal module.
 */
export async function loadOrCreateFleetTokens(): Promise<FleetTokensFile> {
  return loadOrCreateFleetTokensImpl();
}

/**
 * Back-compat shim: returns just the active token. Prefer
 * `loadOrCreateFleetTokens` to also propagate the accept list.
 */
export async function loadOrCreateFleetToken(): Promise<string> {
  return (await loadOrCreateFleetTokensImpl()).active;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

const ROUTES = [
  { method: 'GET',   path: /^\/api\/typing$/, handler: 'getTyping' },
  { method: 'GET',   path: /^\/api\/feed$/, handler: 'getFeed' },
  { method: 'GET',   path: /^\/api\/directories\/check$/, handler: 'checkDirectory' },
  { method: 'GET',   path: /^\/api\/lines$/, handler: 'getLines' },
  { method: 'POST',  path: /^\/api\/lines$/, handler: 'createLine' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/exists$/, handler: 'checkExists' },
  { method: 'DELETE', path: /^\/api\/lines\/(?<name>[^/]+)$/, handler: 'deleteLine' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)$/, handler: 'getLine' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/chats$/, handler: 'getChats' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/messages$/, handler: 'getMessages' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/messages\/search$/, handler: 'searchMessages' },
  { method: 'GET',   path: /^\/api\/metrics$/, handler: 'getFleetMetrics' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/metrics$/, handler: 'getMetrics' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/access$/, handler: 'getAccess' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/logs$/, handler: 'getLogs' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/send$/, handler: 'send' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/contacts$/, handler: 'saveContact' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/access$/, handler: 'accessUpdate' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/mark-read$/, handler: 'markRead' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/restart$/, handler: 'restart' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/stop$/, handler: 'stop' },
  { method: 'PATCH', path: /^\/api\/lines\/(?<name>[^/]+)\/config$/, handler: 'configUpdate' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/auth$/, handler: 'auth' },
  { method: 'GET',    path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled$/, handler: 'getScheduled' },
  { method: 'POST',   path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled$/, handler: 'createScheduled' },
  { method: 'DELETE', path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled$/, handler: 'cancelScheduled' },
  { method: 'GET',    path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled\/(?<id>\d+)$/, handler: 'getScheduledById' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled\/(?<id>\d+)$/, handler: 'updateScheduled' },
  { method: 'DELETE', path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled\/(?<id>\d+)$/, handler: 'cancelScheduledById' },
  { method: 'GET',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups$/, handler: 'getGroups' },
  { method: 'POST',   path: /^\/api\/lines\/(?<name>[^/]+)\/groups$/, handler: 'createGroup' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/subject$/, handler: 'updateGroupSubject' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/description$/, handler: 'updateGroupDescription' },
  { method: 'POST',   path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/participants$/, handler: 'groupParticipants' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/settings$/, handler: 'groupSettings' },
  { method: 'GET',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/invite$/, handler: 'getGroupInvite' },
  { method: 'POST',   path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/invite\/revoke$/, handler: 'revokeGroupInvite' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/ephemeral$/, handler: 'groupEphemeral' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/member-add-mode$/, handler: 'groupMemberAddMode' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/join-approval$/, handler: 'groupJoinApproval' },
  { method: 'GET',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/requests$/, handler: 'getGroupRequests' },
  { method: 'POST',   path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/requests$/, handler: 'groupRequestsUpdate' },
  { method: 'GET',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)$/, handler: 'getGroupDetail' },
  { method: 'DELETE', path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)$/, handler: 'leaveGroup' },
  { method: 'GET',    path: /^\/api\/lines\/(?<name>[^/]+)\/contacts\/search$/, handler: 'searchContacts' },
  { method: 'GET',   path: /^\/api\/version$/, handler: 'getVersion' },
  { method: 'POST',  path: /^\/api\/update$/,  handler: 'update' },
  { method: 'GET',   path: /^\/api\/lid-mappings$/, handler: 'getLidMappings' },
  { method: 'POST',  path: /^\/api\/lid-mappings\/sync$/, handler: 'syncLidMappings' },
] as const satisfies ReadonlyArray<{ method: string; path: RegExp; handler: RouteKey }>;

// ---------------------------------------------------------------------------
// L5: Cross-instance LID mapping sync handlers
// ---------------------------------------------------------------------------

/** GET /api/lid-mappings — export all LID mappings from all instances. */
function handleGetLidMappings(_req: IncomingMessage, res: ServerResponse, deps: RouteDeps): void {
  try {
    const instances = [...deps.discovery.getInstances().values()];
    const allMappings: Array<{ lid: string; phone_jid: string; instance: string }> = [];
    const seen = new Set<string>();

    for (const inst of instances) {
      const result = deps.dbReader.query(inst.name, inst.dbPath, (db: DatabaseSync) => {
        return db.prepare('SELECT lid, phone_jid FROM lid_mappings').all() as Array<{ lid: string; phone_jid: string }>;
      });
      if (result.ok) {
        for (const m of result.data) {
          if (!seen.has(m.lid)) {
            seen.add(m.lid);
            allMappings.push({ ...m, instance: inst.name });
          }
        }
      }
    }

    jsonResponse(res, 200, { mappings: allMappings, count: allMappings.length });
  } catch (err) {
    log.error({ err }, 'L5: failed to export LID mappings');
    jsonResponse(res, 500, { error: 'internal error' });
  }
}

/** POST /api/lid-mappings/sync — broadcast LID mappings to all instances. */
async function handleSyncLidMappings(_req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  try {
    const instances = [...deps.discovery.getInstances().values()];

    // Step 1: collect every instance's (lid, phone_jid, updated_at) so the
    // freshness gate in writeLidMapping can compare cross-instance observation
    // times correctly. The pre-#251 path used a Map<lid,phone> which silently
    // dropped staleness signal.
    const observations: FleetMappingInput[] = [];
    for (const inst of instances) {
      const result = deps.dbReader.query(inst.name, inst.dbPath, (db: DatabaseSync) => {
        return db
          .prepare('SELECT lid, phone_jid, updated_at FROM lid_mappings')
          .all() as Array<{ lid: string; phone_jid: string; updated_at: string }>;
      });
      if (result.ok) {
        for (const m of result.data) {
          observations.push({
            lid: m.lid,
            phone_jid: m.phone_jid,
            updated_at: m.updated_at,
            source_instance: inst.name,
          });
        }
      }
    }

    // Step 2: write into every instance via the unified seam (strict freshness
    // gate on L5). Keep `results` backward-compatible as imported-count/-1 and
    // expose richer counters separately.
    const results: Record<string, number> = {};
    const details: Record<
      string,
      { imported: number; flipped: number; noop: number; conflicts: number; error?: string }
    > = {};
    for (const inst of instances) {
      const writeResult = deps.dbReader.queryWrite(inst.name, inst.dbPath, (rawDb: DatabaseSync) => {
        // Build a minimal Database-shaped facade so importLidMappings can
        // operate on the underlying raw handle without us instantiating a
        // full Database instance against a path we don't own here.
        const dbFacade = { raw: rawDb } as unknown as import('../core/database.ts').Database;
        return importLidMappings(dbFacade, observations);
      });
      if (writeResult.ok) {
        const r = writeResult.data;
        results[inst.name] = r.imported;
        details[inst.name] = {
          imported: r.imported,
          flipped: r.flipped,
          noop: r.noop,
          conflicts: r.conflicts.length,
        };
      } else {
        results[inst.name] = -1;
        details[inst.name] = {
          imported: 0,
          flipped: 0,
          noop: 0,
          conflicts: 0,
          error: writeResult.error,
        };
      }
    }

    const totalMappings = observations.length;
    log.info({ totalMappings, results, details }, 'L5: cross-instance LID sync completed');
    jsonResponse(res, 200, { totalMappings, results, details });
  } catch (err) {
    log.error({ err }, 'L5: failed to sync LID mappings');
    jsonResponse(res, 500, { error: 'internal error' });
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createFleetServer(deps: FleetDeps) {
  const discovery = new FleetDiscovery();
  const healthPoller = new HealthPoller(
    () => discovery.getInstances() as any,
    deps.selfName,
    deps.getSelfHealth,
  );
  const dbReader = new FleetDbReader(deps.selfName, deps.db);

  // Determine dist directory for static files
  const distDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'dist');

  const updateChecker = new UpdateChecker(repoRoot);

  // Read startup SHA synchronously so the first HTML request has the correct version
  // (before UpdateChecker's async checkNow() completes). After that, the getter reads
  // from the checker which stays fresh after each git pull.
  let startupSha = 'unknown';
  try {
    startupSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim();
  } catch { /* git not available */ }
  const getVersion = () => {
    const s = updateChecker.getState().sha;
    return (s && s !== 'unknown') ? s : startupSha;
  };
  function getTokenSet(): { active: string; accept: readonly string[] } {
    return deps.getFleetTokens?.() ?? { active: deps.fleetToken, accept: deps.acceptTokens ?? [] };
  }

  const staticHandler = createStaticHandler(distDir, () => getTokenSet().active, getVersion);
  // Realtime publisher is wired after wsServer creation — use a deferred reference
  let realtimePublish: (event: import('./websocket-server.ts').WsEvent) => void = () => {};
  const realtime: FleetRealtimePublisher = { publish: (event) => realtimePublish(event) };
  const serviceManager = createServiceManager();
  const routeDeps: RouteDeps = { discovery, healthPoller, dbReader, realtime, serviceManager, log, updateChecker };

  // ---- Auth helpers (rotation-aware) -----------------------------------
  function verifyToken(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    return verifyFleetTokenImpl(candidate, getTokenSet());
  }
  const ticketStore: TicketStore = createTicketStore();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];

    // API routes require auth
    if (pathname.startsWith('/api/')) {
      // Accept Bearer header or ?token= query param (EventSource can't set headers).
      // Both paths walk the active+accept token set so a rotated-out token still
      // works for the duration of its grace window.
      const queryToken = parseQueryString(url).token ?? '';
      const bearer = extractBearer(req);
      if (!verifyToken(bearer) && !verifyToken(queryToken)) {
        jsonResponse(res, 401, { error: 'unauthorized' });
        return;
      }

      // Special-case: ticket vending. The ticket store needs `active` (the
      // signing key) and the live ticket-issuance interface, so it sits
      // outside the table-driven ROUTES.
      if (method === 'POST' && pathname === '/api/ws-ticket') {
        // Defensively drain any body so the connection stays clean even if
        // a client posted something.
        try { await readBody(req, 1024); } catch { /* ignore — body is optional */ }
        const { ticket, expiresIn } = ticketStore.issue(getTokenSet().active);
        jsonResponse(res, 200, { ticket, expiresIn });
        return;
      }

      for (const route of ROUTES) {
        const params = parseRoute(method, url, route);
        if (params) {
          if (hasNameParam(route.handler)) {
            if (typeof params.name !== 'string') continue;
            // Safe: regex named groups produce the exact shape each handler expects
            // ({name}, {name,id}, or {name,jid}). TypeScript can't prove this statically
            // because the handler key is a runtime value — the ROUTES array + RouteParamsByHandler
            // type map guarantee correctness.
            const handler = handlers[route.handler] as unknown as (
              req: IncomingMessage, res: ServerResponse, deps: RouteDeps, params: Record<string, string>,
            ) => void | Promise<void>;
            await handler(req, res, routeDeps, params);
            return;
          }

          await handlers[route.handler](req, res, routeDeps, EMPTY_ROUTE_PARAMS);
          return;
        }
      }

      jsonResponse(res, 404, { error: 'not found' });
      return;
    }

    // Static file serving for non-API routes
    if (!staticHandler(req, res)) {
      jsonResponse(res, 404, { error: 'not found' });
    }
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      const raw = (err as { statusCode?: unknown })?.statusCode;
      const status =
        typeof raw === 'number' && raw >= 400 && raw < 600 ? raw : 500;
      const message =
        status === 500 ? 'internal error' : (err as Error)?.message ?? 'error';
      if (status === 500) {
        log.error({ err }, 'unhandled fleet request error');
      } else {
        log.warn({ err, status }, 'fleet request rejected');
      }
      try {
        jsonResponse(res, status, { error: message });
      } catch { /* response already started */ }
    });
  });

  // WebSocket server for real-time console updates.
  // Auth: ticket-first (HMAC tickets minted via POST /api/ws-ticket); legacy
  // `?token=<active>` still works for one rollout cycle.
  const wsServer = new FleetWebSocketServer(server, {
    ticketStore,
    ticketValidKeys: () => {
      const tokenSet = getTokenSet();
      return [tokenSet.active, ...tokenSet.accept];
    },
    verifyLegacyToken: (token) => verifyToken(token),
  });

  // Now that wsServer exists, wire the deferred publisher
  realtimePublish = (event) => wsServer.broadcast(event);

  // Wire HealthPoller status changes to WS broadcasts
  healthPoller.on('statusChange', (instance: string) => {
    realtime.publish({ type: 'instance_status', instance });
  });

  // Realtime event poller — snapshot-diff for messages/access/typing
  const realtimePoller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime });

  return {
    server,
    discovery,
    healthPoller,
    dbReader,
    wsServer,
    realtimePoller,
    start(port: number): void {
      discovery.startAutoRefresh();
      healthPoller.start();
      updateChecker.start();
      realtimePoller.start();
      const host = process.env.FLEET_BIND_ADDRESS ?? '127.0.0.1';
      server.listen(port, host, () => {
        log.info({ port, host, ws: true }, 'fleet server listening');
      });
    },
    stop(): void {
      realtimePoller.stop();
      healthPoller.stop();
      discovery.stop();
      updateChecker.stop();
      ticketStore.stop();
      wsServer.close();
      server.close();
    },
  };
}
