import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createChildLogger } from '../logger.ts';
import { jsonResponse, parseRoute, parseQueryString, readBody, extractBearer } from '../lib/http.ts';
import { cleanGitEnv } from '../lib/git-env.ts';
import { FleetDiscovery } from './discovery.ts';
import { HealthPoller } from './health-poller.ts';
import { FleetDbReader } from './db-reader.ts';
import { createStaticHandler } from './static.ts';
import { createLivenessHandler } from './livez.ts';
import { handleGetLines, handleGetLine, handleGetLineProviderStatus } from './routes/lines.ts';
import { handleGetLineCheckpoints, handleRestoreCheckpoint } from './routes/checkpoints.ts';
import { handleGetLiveSessions } from './routes/live-sessions.ts';
import { handleGetProviders } from './routes/providers.ts';
import { handlePutCredential, handleDeleteCredential, handleVerifyCredential, handleGetCredential, setExtraCredentialServices, type CredentialDeps } from './routes/credentials.ts';
import { handleGetSilences, handleAddSilence, handleRemoveSilence } from './routes/silence.ts';
import { handleGetChats, handleGetMessages, handleSearchMessages, handleGetAccess, handleGetLogs, handleGetTyping, handleCheckExists, handleCheckDirectory } from './routes/data.ts';
import { handleSend, handleAccessUpdate, handleSaveContact, handleRestart, handleStop, handleConfigUpdate, handleCreateLine, handleDeleteLine, handleAuth, handleMarkRead } from './routes/ops.ts';
import { handleGetFeed } from './routes/feed.ts';
import { handleGetMetrics } from './routes/metrics.ts';
import { handleGetFleetMetrics } from './routes/fleet-metrics.ts';
import { handleGetRateLimits } from './routes/rate-limits.ts';
import { handleGetApprovals, handlePostApprovalDecision } from './routes/approvals.ts';
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
import { compareLidUpdatedAt, importLidMappings, type FleetMappingInput } from '../core/lid-resolver.ts';
import type { DatabaseSync } from 'node:sqlite';
import { FleetWebSocketServer } from './websocket-server.ts';
import type { FleetRealtimePublisher } from './realtime-publisher.ts';
import { publishLidConflict } from './realtime-publisher.ts';
import { FleetRealtimeEventPoller } from './realtime-event-poller.ts';
import {
  loadOrCreateFleetTokens as loadOrCreateFleetTokensImpl,
  verifyFleetToken as verifyFleetTokenImpl,
  type FleetTokensFile,
} from './token-storage.ts';
import { createTicketStore as createWsTicketStore, TICKET_TTL_MS, type TicketStore } from './ws-ticket.ts';
import {
  createTicketStore as createAuthTicketStore,
  isTicketAudience,
  type TicketStore as AuthTicketStore,
  type TicketAudience,
} from './auth-ticket.ts';
import { repoRoot } from './paths.ts';

const log = createChildLogger('fleet');

export const HTTP_LEGACY_QUERY_TOKEN_REMOVAL_DATE = '2026-06-30';

export { DEFAULT_FLEET_PORT } from './constants.ts';
import { assertSafeFleetBind } from './bind-guard.ts';
import {
  createConsoleSessionStore,
  buildSessionCookie,
  buildSessionClearCookie,
  parseSessionCookie,
  isSameOriginRequest,
  isSecureRequestTransport,
  isLoopbackRequest,
} from './console-session.ts';

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
  getProviders: EmptyRouteParams;
  putCredential: NameRouteParams;
  deleteCredential: NameRouteParams;
  verifyCredential: NameRouteParams;
  getCredential: NameRouteParams;
  getLines: EmptyRouteParams;
  getLine: NameRouteParams;
  getLineProviderStatus: NameRouteParams;
  getLineCheckpoints: NameRouteParams;
  getRateLimits: NameRouteParams;
  restoreCheckpoint: NameRouteParams;
  getLiveSessions: NameRouteParams;
  getApprovals: NameRouteParams;
  postApprovalDecision: NameRouteParams;
  getSilences: EmptyRouteParams;
  addSilence: EmptyRouteParams;
  removeSilence: NameRouteParams;
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
  'getLineProviderStatus',
  'getLineCheckpoints',
  'getRateLimits',
  'getLiveSessions',
  'getApprovals',
  'postApprovalDecision',
  'putCredential',
  'deleteCredential',
  'verifyCredential',
  'getCredential',
  'removeSilence',
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
  getProviders: (req, res, _deps, _params) => handleGetProviders(req, res),
  putCredential: (req, res, _deps, params) => handlePutCredential(req, res, params),
  deleteCredential: (req, res, deps, params) => handleDeleteCredential(req, res, params, buildCredentialDeps(deps)),
  verifyCredential: (req, res, _deps, params) => handleVerifyCredential(req, res, params),
  getCredential: (req, res) => handleGetCredential(req, res),
  getLines:     (req, res, deps, _params) => handleGetLines(req, res, deps),
  getLine:      (req, res, deps, params) => handleGetLine(req, res, deps, params),
  getLineProviderStatus: (req, res, deps, params) => handleGetLineProviderStatus(req, res, deps, params),
  getLineCheckpoints: (req, res, deps, params) => handleGetLineCheckpoints(req, res, deps, params),
  getRateLimits: (req, res, deps, params) => handleGetRateLimits(req, res, deps, params),
  restoreCheckpoint: (req, res, deps, params) => handleRestoreCheckpoint(req, res, deps, params),
  getLiveSessions: (req, res, deps, params) => handleGetLiveSessions(req, res, deps, params),
  getApprovals: (req, res, deps, params) => handleGetApprovals(req, res, deps, params),
  postApprovalDecision: (req, res, deps, params) => handlePostApprovalDecision(req, res, deps, params),
  getSilences:  (req, res, _deps, _params) => handleGetSilences(req, res),
  addSilence:   (req, res, _deps, _params) => handleAddSilence(req, res),
  removeSilence: (req, res, _deps, params) => handleRemoveSilence(req, res, { instance: params.name }),
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
  { method: 'GET',    path: /^\/api\/fleet\/silences$/, handler: 'getSilences' },
  { method: 'POST',   path: /^\/api\/fleet\/silence$/, handler: 'addSilence' },
  { method: 'DELETE', path: /^\/api\/fleet\/silence\/(?<name>[^/]+)$/, handler: 'removeSilence' },
  { method: 'GET',   path: /^\/api\/typing$/, handler: 'getTyping' },
  { method: 'GET',   path: /^\/api\/feed$/, handler: 'getFeed' },
  { method: 'GET',   path: /^\/api\/directories\/check$/, handler: 'checkDirectory' },
  { method: 'GET',   path: /^\/api\/providers$/, handler: 'getProviders' },
  { method: 'PUT',    path: /^\/api\/credentials\/(?<name>[^/]+)$/, handler: 'putCredential' },
  { method: 'DELETE', path: /^\/api\/credentials\/(?<name>[^/]+)$/, handler: 'deleteCredential' },
  { method: 'POST',   path: /^\/api\/credentials\/(?<name>[^/]+)\/verify$/, handler: 'verifyCredential' },
  { method: 'GET',    path: /^\/api\/credentials\/(?<name>[^/]+)$/, handler: 'getCredential' },
  { method: 'GET',   path: /^\/api\/lines$/, handler: 'getLines' },
  { method: 'POST',  path: /^\/api\/lines$/, handler: 'createLine' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/exists$/, handler: 'checkExists' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/provider-status$/, handler: 'getLineProviderStatus' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/checkpoints$/, handler: 'getLineCheckpoints' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/rate-limits$/, handler: 'getRateLimits' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/checkpoints\/restore$/, handler: 'restoreCheckpoint' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/live-sessions$/, handler: 'getLiveSessions' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/approvals$/, handler: 'getApprovals' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/approvals\/decision$/, handler: 'postApprovalDecision' },
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

type LidMappingObservation = {
  lid: string;
  phone_jid: string;
  updated_at: string;
  instance: string;
};

type LidMappingInstance = {
  instance: string;
  updated_at: string;
};

type UnifiedLidMapping = {
  lid: string;
  phone_jid: string;
  instances: LidMappingInstance[];
};

type ConflictResolutionReason = 'freshest' | 'tied-deterministic';

type ConflictResolution = {
  phone_jid: string;
  source_instance: string;
  reason: ConflictResolutionReason;
};

type ConflictingLidMapping = {
  lid: string;
  phones: Array<{
    phone_jid: string;
    instances: LidMappingInstance[];
  }>;
  /**
   * Deterministic resolution preview (#251 §3.3). Mirrors `writeLidMapping`
   * in `freshness-gated` mode: parsed max `updated_at` wins; on tie,
   * alphabetical `phone_jid` wins with reason `tied-deterministic`.
   * `source_instance` is the instance whose observation provided the winning
   * phone's max `updated_at`; on a within-phone tie, alphabetically-first
   * instance.
   */
  resolution: ConflictResolution;
};

/**
 * Compute the deterministic resolution for a conflicting LID. The conflict's
 * `phones` array is assumed already sorted alphabetically by phone_jid and
 * each phone's `instances` is assumed already sorted via `compareLidInstances`
 * (instance name ascending then updated_at ascending).
 */
function resolveConflict(phones: ConflictingLidMapping['phones']): ConflictResolution {
  // Per phone, derive the maximum observed updated_at + the instance that
  // provided it. On within-phone tie, pick the alphabetically-first instance.
  const perPhone = phones.map(({ phone_jid, instances }) => {
    let maxAt = '';
    let maxInst = '';
    for (const inst of instances) {
      const byFreshness = maxAt === '' ? 1 : compareLidUpdatedAt(inst.updated_at, maxAt);
      if (byFreshness > 0) {
        maxAt = inst.updated_at;
        maxInst = inst.instance;
      } else if (byFreshness === 0 && (maxInst === '' || inst.instance < maxInst)) {
        maxInst = inst.instance;
      }
    }
    return { phone_jid, maxAt, maxInst };
  });

  // Find the overall freshest phone(s).
  const overallMax = perPhone.reduce(
    (acc, p) => (acc === '' || compareLidUpdatedAt(p.maxAt, acc) > 0 ? p.maxAt : acc),
    '',
  );
  const tied = perPhone.filter(p => compareLidUpdatedAt(p.maxAt, overallMax) === 0);

  if (tied.length === 1) {
    return {
      phone_jid: tied[0].phone_jid,
      source_instance: tied[0].maxInst,
      reason: 'freshest',
    };
  }

  // Tied: alphabetically-first phone wins.
  const winner = tied.toSorted((a, b) => a.phone_jid.localeCompare(b.phone_jid))[0];
  return {
    phone_jid: winner.phone_jid,
    source_instance: winner.maxInst,
    reason: 'tied-deterministic',
  };
}

function compareLidInstances(a: LidMappingInstance, b: LidMappingInstance): number {
  return a.instance.localeCompare(b.instance) || a.updated_at.localeCompare(b.updated_at);
}

function buildConflictExplicitLidMappings(observations: LidMappingObservation[]): {
  unified: UnifiedLidMapping[];
  conflicts: ConflictingLidMapping[];
} {
  const byLid = new Map<string, Map<string, LidMappingInstance[]>>();
  for (const obs of observations) {
    let byPhone = byLid.get(obs.lid);
    if (!byPhone) {
      byPhone = new Map<string, LidMappingInstance[]>();
      byLid.set(obs.lid, byPhone);
    }

    let instances = byPhone.get(obs.phone_jid);
    if (!instances) {
      instances = [];
      byPhone.set(obs.phone_jid, instances);
    }
    instances.push({ instance: obs.instance, updated_at: obs.updated_at });
  }

  const unified: UnifiedLidMapping[] = [];
  const conflicts: ConflictingLidMapping[] = [];
  for (const [lid, byPhone] of [...byLid.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const phones = [...byPhone.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (phones.length === 1) {
      const [phone_jid, instances] = phones[0];
      unified.push({
        lid,
        phone_jid,
        instances: instances.toSorted(compareLidInstances),
      });
      continue;
    }

    const sortedPhones = phones.map(([phone_jid, instances]) => ({
      phone_jid,
      instances: instances.toSorted(compareLidInstances),
    }));
    conflicts.push({
      lid,
      phones: sortedPhones,
      resolution: resolveConflict(sortedPhones),
    });
  }

  return { unified, conflicts };
}

/** GET /api/lid-mappings — export all LID mappings from all instances. */
function handleGetLidMappings(_req: IncomingMessage, res: ServerResponse, deps: RouteDeps): void {
  try {
    const instances = [...deps.discovery.getInstances().values()];
    const allMappings: Array<{ lid: string; phone_jid: string; instance: string }> = [];
    const observations: LidMappingObservation[] = [];
    const seen = new Set<string>();

    for (const inst of instances) {
      const result = deps.dbReader.query(inst.name, inst.dbPath, (db: DatabaseSync) => {
        return db.prepare('SELECT lid, phone_jid, updated_at FROM lid_mappings').all() as Array<{
          lid: string;
          phone_jid: string;
          updated_at: string;
        }>;
      });
      if (result.ok) {
        for (const m of result.data) {
          observations.push({ ...m, instance: inst.name });
          if (!seen.has(m.lid)) {
            seen.add(m.lid);
            allMappings.push({ lid: m.lid, phone_jid: m.phone_jid, instance: inst.name });
          }
        }
      }
    }

    const { unified, conflicts } = buildConflictExplicitLidMappings(observations);

    jsonResponse(res, 200, {
      mappings: allMappings,
      count: allMappings.length,
      unified,
      conflicts,
      conflict_count: conflicts.length,
    });
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
      {
        imported: number;
        flipped: number;
        noop: number;
        conflicts: number;
        skipped?: boolean;
        reason?: string;
        schemaVersion?: number;
        error?: string;
      }
    > = {};
    const skippedInstances: Array<{ instance: string; schemaVersion: number; required: number; reason: string }> = [];
    for (const inst of instances) {
      const writeResult = deps.dbReader.queryWrite(inst.name, inst.dbPath, (rawDb: DatabaseSync) => {
        const schemaVersion = readSchemaMigrationVersion(rawDb);
        if (schemaVersion < 25) {
          return {
            imported: 0,
            flipped: 0,
            noop: 0,
            conflicts: [],
            skipped: true,
            reason: 'schema_migration_below_25',
            schemaVersion,
          } as const;
        }

        // Build a minimal Database-shaped facade so importLidMappings can
        // operate on the underlying raw handle without us instantiating a
        // full Database instance against a path we don't own here.
        const dbFacade = { raw: rawDb } as unknown as import('../core/database.ts').Database;
        return { ...importLidMappings(dbFacade, observations), schemaVersion };
      });
      if (writeResult.ok) {
        const r = writeResult.data;
        results[inst.name] = r.imported;
        details[inst.name] = {
          imported: r.imported,
          flipped: r.flipped,
          noop: r.noop,
          conflicts: r.conflicts.length,
          schemaVersion: r.schemaVersion,
          ...(r.skipped ? { skipped: true, reason: r.reason } : {}),
        };
        // Surface every freshness-rejected write so consoles can refetch
        // the mappings panel (#251). `r.conflicts` is the array of writes
        // that lost the gate on this peer.
        if (!r.skipped) {
          for (const c of r.conflicts) {
            publishLidConflict(deps.realtime, inst.name, c.lid);
          }
        }
        if (r.skipped) {
          skippedInstances.push({
            instance: inst.name,
            schemaVersion: r.schemaVersion,
            required: 25,
            reason: r.reason,
          });
        }
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
    log.info({ totalMappings, results, details, skippedInstances }, 'L5: cross-instance LID sync completed');
    jsonResponse(res, 200, { totalMappings, results, details, skippedInstances });
  } catch (err) {
    log.error({ err }, 'L5: failed to sync LID mappings');
    jsonResponse(res, 500, { error: 'internal error' });
  }
}

function readSchemaMigrationVersion(rawDb: DatabaseSync): number {
  try {
    const row = rawDb
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null } | undefined;
    return typeof row?.version === 'number' ? row.version : 0;
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('no such table: schema_migrations')) {
      return 0;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Build the CredentialDeps slice that the DELETE credential handler needs:
 * a list of discovered instances with their agentOptions, read synchronously
 * from the discovery cache. Follows the same config-read pattern as
 * handleGetLineProviderStatus (lines.ts).
 */
function buildCredentialDeps(deps: RouteDeps): CredentialDeps {
  const instances: CredentialDeps['instances'] = [];
  for (const inst of deps.discovery.getInstances().values()) {
    let agentOptions: CredentialDeps['instances'][number]['agentOptions'] = {};
    try {
      const raw = JSON.parse(fs.readFileSync(inst.configPath, 'utf-8')) as Record<string, unknown>;
      const opts = raw.agentOptions;
      if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
        agentOptions = opts as CredentialDeps['instances'][number]['agentOptions'];
      }
    } catch { /* config unreadable */ }
    instances.push({ name: inst.name, agentOptions });
  }
  return { instances };
}

export function createFleetServer(deps: FleetDeps) {
  const discovery = new FleetDiscovery();
  const dbReader = new FleetDbReader(deps.selfName, deps.db);
  const healthPoller = new HealthPoller(
    () => discovery.getInstances() as any,
    deps.selfName,
    deps.getSelfHealth,
    undefined,
    undefined,
    // #1786 (P2 fix): give the durable auth_loss_signal latch a production writer that
    // targets each instance's OWN persistent, migrated DB via dbReader.queryWrite — never
    // deps.db (the fleet server's own throwaway :memory: handle in production, standalone.ts).
    dbReader,
  );

  // Determine dist directory for static files
  const distDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'dist');

  const updateChecker = new UpdateChecker(repoRoot);

  // Read startup SHA synchronously so the first HTML request has the correct version
  // (before UpdateChecker's async checkNow() completes). After that, the getter reads
  // from the checker which stays fresh after each git pull.
  let startupSha = 'unknown';
  try {
    startupSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, env: cleanGitEnv() }).toString().trim();
  } catch { /* git not available */ }
  const getVersion = () => {
    const s = updateChecker.getState().sha;
    return (s && s !== 'unknown') ? s : startupSha;
  };
  function getTokenSet(): { active: string; accept: readonly string[] } {
    return deps.getFleetTokens?.() ?? { active: deps.fleetToken, accept: deps.acceptTokens ?? [] };
  }

  const staticHandler = createStaticHandler(distDir, getVersion);
  const livenessHandler = createLivenessHandler({ selfName: deps.selfName, startedAtMs: Date.now() });
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
  const ticketStore: TicketStore = createWsTicketStore();
  // Audience-scoped store for HTTP and SSE tickets (#313). The WS path keeps
  // using `ticketStore` above so call sites do not need to care about the
  // shared audience-scoped implementation.
  const apiTicketStore: AuthTicketStore = createAuthTicketStore();

  /**
   * Audience-scoped HTTP/SSE auth gate (#313).
   *
   * Two acceptance paths during the deprecation window:
   *   (a) the root fleet token via Bearer or `?token=` query (legacy)
   *   (b) an audience-scoped ticket via `?ticket=` query or Bearer header
   *
   * Audience is derived from the route shape:
   *   - SSE endpoints (currently `/api/lines/:name/auth`) require audience='sse'
   *   - everything else under `/api/*` accepts audience='api'
   *   - the ticket-vending endpoint itself is anchored to the root token (the
   *     bootstrap credential) and is gated separately.
   */
  function audienceForPath(pathname: string): TicketAudience {
    // Currently the only SSE endpoint is `/api/lines/:name/auth`.
    if (/^\/api\/lines\/[^/]+\/auth$/.test(pathname)) return 'sse';
    return 'api';
  }

  function verifyApiTicketCandidate(candidate: string | undefined | null, audience: TicketAudience): boolean {
    if (!candidate) return false;
    const tokenSet = getTokenSet();
    const validKeys = [tokenSet.active, ...tokenSet.accept];
    return apiTicketStore.redeem(candidate, audience, validKeys);
  }

  // Console sessions (B1 closure): the browser unlocks once with the root
  // token and thereafter authenticates ticket vending with an HttpOnly
  // cookie + same-origin proof. In-memory by design — restart relocks.
  const consoleSessions = createConsoleSessionStore();

  function verifyConsoleSession(req: IncomingMessage): boolean {
    const sessionId = parseSessionCookie(req.headers.cookie);
    if (!sessionId) return false;
    if (!consoleSessions.validate(sessionId)) {
      // Distinguishable from a plain unauthenticated 401: a cookie was
      // presented but the session is expired/revoked/unknown.
      log.warn(
        { event: 'console_token_missing_or_invalid', reason: 'session-invalid-or-expired', path: (req.url ?? '').split('?')[0] },
        'console session cookie presented but not valid',
      );
      return false;
    }
    if (!isSameOriginRequest(req)) {
      log.warn(
        { event: 'console_csrf_rejected', origin: req.headers.origin ?? null, method: req.method, path: (req.url ?? '').split('?')[0] },
        'console session presented without same-origin proof',
      );
      return false;
    }
    return true;
  }

  // C2: the root-token bootstrap (mint) endpoints must only be reachable from
  // the loopback interface. Phase A binds the fleet to loopback and Phase B
  // fronts it with `tailscale serve` (which proxies from 127.0.0.1), so every
  // legitimate mint — local or serve-fronted remote — arrives with a loopback
  // source. This gate fails closed against a bind regression that would expose
  // the mint endpoints to raw tailnet peers. Ephemeral-ticket SENDS are not
  // gated here; only the rare root-token mint paths are.
  function requireLoopbackMint(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (isLoopbackRequest(req)) return true;
    log.warn(
      { event: 'mint_nonloopback_rejected', path: pathname, remoteAddress: req.socket?.remoteAddress ?? null },
      'root-token mint endpoint refused a non-loopback source',
    );
    jsonResponse(res, 403, { error: 'mint endpoints are loopback-only' });
    return false;
  }

  // Deprecation warning state for legacy `?token=<root>` HTTP API auth.
  // Mirrors `ws_legacy_token_path` on the WebSocket path (#393): one-shot
  // per server lifetime so a misbehaving caller hitting many endpoints does
  // not spam logs. The legacy path itself remains functional until the
  // removal date above.
  let httpLegacyTokenWarningEmitted = false;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];

    // Dashboard-independent liveness (`/livez`): answers from process state
    // alone, before auth and before any static-asset dependency, so a watchdog
    // can tell "process serving" from "console assets missing" without the
    // root-`/` 404 that a build-omitted release produces. Loopback-bound like
    // the rest of the server; intentionally unauthenticated.
    if (livenessHandler(req, res)) return;

    // API routes require auth
    if (pathname.startsWith('/api/')) {
      const query = parseQueryString(url);
      const queryToken = query.token ?? '';
      const queryTicket = query.ticket ?? '';
      const bearer = extractBearer(req);

      // Console unlock (B1): the operator presents the root token once;
      // the browser receives an HttpOnly session cookie, never the token.
      if (method === 'POST' && pathname === '/api/console-session') {
        if (!requireLoopbackMint(req, res, pathname)) return;
        if (!verifyToken(bearer)) {
          log.warn({ event: 'console_session_rejected', reason: 'invalid-root-token', origin: req.headers.origin ?? null }, 'console unlock rejected');
          jsonResponse(res, 401, { error: 'unauthorized' });
          return;
        }
        if (!isSameOriginRequest(req)) {
          log.warn({ event: 'console_session_rejected', reason: 'origin-mismatch', origin: req.headers.origin ?? null }, 'console unlock rejected');
          jsonResponse(res, 403, { error: 'origin not allowed' });
          return;
        }
        const { sessionId, expiresIn } = consoleSessions.issue();
        log.info({ event: 'console_session_bootstrap', expiresIn, liveSessions: consoleSessions.size() }, 'console session issued');
        res.setHeader('Set-Cookie', buildSessionCookie(sessionId, { secure: isSecureRequestTransport(req) }));
        jsonResponse(res, 200, { expiresIn });
        return;
      }

      // Console lock / logout — revokes the presented session. Deliberately
      // requires nothing beyond cookie possession (no Origin proof): a caller
      // holding the cookie can already use the session, so letting them
      // revoke it is strictly risk-reducing, and CLI operators can log out
      // without header ceremony.
      if (method === 'DELETE' && pathname === '/api/console-session') {
        const sessionId = parseSessionCookie(req.headers.cookie);
        if (sessionId) consoleSessions.revoke(sessionId);
        log.info({ event: 'console_session_revoked', hadSession: sessionId !== null }, 'console session revoked');
        res.setHeader('Set-Cookie', buildSessionClearCookie());
        jsonResponse(res, 200, { ok: true });
        return;
      }

      // Bootstrap ticket endpoints accept the root fleet token via
      // Authorization, or (for browsers) a valid console session cookie
      // with same-origin proof. They intentionally do not accept `?token=`
      // because these POST routes do not have EventSource's header limitation.
      if (method === 'POST' && pathname === '/api/auth-ticket') {
        if (!requireLoopbackMint(req, res, pathname)) return;
        if (!verifyToken(bearer) && !verifyConsoleSession(req)) {
          jsonResponse(res, 401, { error: 'unauthorized' });
          return;
        }
        let body: unknown = null;
        try {
          const raw = await readBody(req, 1024);
          if (raw && raw.length > 0) body = JSON.parse(raw);
        } catch {
          jsonResponse(res, 400, { error: 'invalid body' });
          return;
        }
        const audience = (body as { audience?: unknown } | null)?.audience;
        if (!isTicketAudience(audience) || audience === 'ws') {
          jsonResponse(res, 400, { error: 'audience must be "api" or "sse"' });
          return;
        }
        const { ticket, expiresIn } = apiTicketStore.issue(getTokenSet().active, audience);
        jsonResponse(res, 200, { ticket, audience, expiresIn });
        return;
      }

      // Legacy WS ticket vending remains a root-token bootstrap path. Do
      // this before the generic API ticket gate so an `api`-audience ticket
      // cannot be exchanged for WebSocket capability.
      if (method === 'POST' && pathname === '/api/ws-ticket') {
        if (!requireLoopbackMint(req, res, pathname)) return;
        if (!verifyToken(bearer) && !verifyConsoleSession(req)) {
          jsonResponse(res, 401, { error: 'unauthorized' });
          return;
        }
        try { await readBody(req, 1024); } catch { /* ignore -- body is optional */ }
        const { ticket, expiresIn } = ticketStore.issue(getTokenSet().active);
        jsonResponse(res, 200, { ticket, expiresIn });
        return;
      }

      const audience = audienceForPath(pathname);
      // Accept (a) root token via Bearer/?token=, OR (b) audience-scoped
      // ticket via ?ticket=. Bearer header may also carry a ticket so
      // browsers don't have to special-case the HTTP API client; we try
      // both interpretations and accept the first success.
      const bearerRootOk = verifyToken(bearer);
      const queryRootOk = !bearerRootOk && verifyToken(queryToken);
      const rootOk = bearerRootOk || queryRootOk;
      // Deprecation warning for legacy `?token=<root>` HTTP API auth (#393).
      // Emit only when authentication actually succeeded via the query path,
      // never on Bearer. One-shot per server lifetime — mirrors the WebSocket
      // `ws_legacy_token_path` warning shape.
      if (queryRootOk && !httpLegacyTokenWarningEmitted) {
        httpLegacyTokenWarningEmitted = true;
        log.warn({ legacy: 'http-token-in-url', path: pathname, removeAfter: HTTP_LEGACY_QUERY_TOKEN_REMOVAL_DATE }, 'http_legacy_token_path');
      }
      const ticketCandidates: string[] = [];
      if (queryTicket) ticketCandidates.push(queryTicket);
      if (bearer && !rootOk) ticketCandidates.push(bearer);
      let ticketOk = false;
      for (const cand of ticketCandidates) {
        if (verifyApiTicketCandidate(cand, audience)) {
          ticketOk = true;
          break;
        }
      }
      if (!rootOk && !ticketOk) {
        jsonResponse(res, 401, { error: 'unauthorized' });
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
      const host = process.env.FLEET_BIND_ADDRESS ?? '127.0.0.1';
      assertSafeFleetBind(host); // fail fast — before any pollers/timers start
      discovery.startAutoRefresh();
      healthPoller.start();
      updateChecker.start();
      realtimePoller.start();
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
      apiTicketStore.stop();
      wsServer.close();
      server.close();
    },
  };
}
