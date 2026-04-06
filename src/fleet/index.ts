import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createChildLogger } from '../logger.ts';
import { jsonResponse, checkBearerAuth, parseRoute, parseQueryString } from '../lib/http.ts';
import { FleetDiscovery } from './discovery.ts';
import { HealthPoller } from './health-poller.ts';
import { FleetDbReader } from './db-reader.ts';
import { createStaticHandler } from './static.ts';
import { handleGetLines, handleGetLine } from './routes/lines.ts';
import { handleGetChats, handleGetMessages, handleSearchMessages, handleGetAccess, handleGetLogs, handleGetTyping, handleCheckExists, handleCheckDirectory } from './routes/data.ts';
import { handleSend, handleAccessUpdate, handleSaveContact, handleRestart, handleStop, handleConfigUpdate, handleCreateLine, handleDeleteLine, handleAuth } from './routes/ops.ts';
import { handleGetFeed } from './routes/feed.ts';
import { handleGetMetrics } from './routes/metrics.ts';
import { handleGetFleetMetrics } from './routes/fleet-metrics.ts';
import { handleGetVersion, handleUpdate } from './routes/update.ts';
import { handleGetScheduled, handleCancelScheduled, handleGetGroups, handleSearchContacts } from './routes/mcp-proxy.ts';
import { UpdateChecker } from './update-checker.ts';
import { xdgDir } from './paths.ts';
import type { DatabaseSync } from 'node:sqlite';
import { FleetWebSocketServer } from './websocket-server.ts';
import type { FleetRealtimePublisher } from './realtime-publisher.ts';
import { FleetRealtimeEventPoller } from './realtime-event-poller.ts';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const log = createChildLogger('fleet');

export interface FleetDeps {
  db: DatabaseSync;
  selfName: string;
  fleetToken: string;
  getSelfHealth: () => Record<string, unknown>;
}

export interface RouteDeps {
  discovery: FleetDiscovery;
  healthPoller: HealthPoller;
  dbReader: FleetDbReader;
  realtime: FleetRealtimePublisher;
  log: typeof log;
  updateChecker: UpdateChecker;
}

// ---------------------------------------------------------------------------
// Handler dispatch map
// ---------------------------------------------------------------------------

type EmptyRouteParams = Record<string, never>;
type NameRouteParams = { name: string };

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
};

type RouteKey = keyof RouteParamsByHandler;
type NamedRouteKey = {
  [K in RouteKey]: RouteParamsByHandler[K] extends NameRouteParams ? K : never
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
  getScheduled:    (_req, res, deps, params) => handleGetScheduled(_req, res, deps, params),
  cancelScheduled: (req, res, deps, params) => handleCancelScheduled(req, res, deps, params),
  getGroups:       (_req, res, deps, params) => handleGetGroups(_req, res, deps, params),
  searchContacts:  (req, res, deps, params) => handleSearchContacts(req, res, deps, params),
};

// ---------------------------------------------------------------------------
// Fleet token management
// ---------------------------------------------------------------------------

/** Load or create the fleet token at ~/.config/whatsoup/fleet-token */
export async function loadOrCreateFleetToken(): Promise<string> {
  const tokenPath = path.join(
    xdgDir('XDG_CONFIG_HOME', '.config'),
    'whatsoup',
    'fleet-token',
  );

  try {
    const raw = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error('fleet-token file is corrupt — regenerating');
    return raw;
  } catch {
    const token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    log.info({ tokenPath }, 'generated new fleet token');
    return token;
  }
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
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/restart$/, handler: 'restart' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/stop$/, handler: 'stop' },
  { method: 'PATCH', path: /^\/api\/lines\/(?<name>[^/]+)\/config$/, handler: 'configUpdate' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/auth$/, handler: 'auth' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled$/, handler: 'getScheduled' },
  { method: 'DELETE', path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled$/, handler: 'cancelScheduled' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/groups$/, handler: 'getGroups' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/contacts\/search$/, handler: 'searchContacts' },
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
    const allMappings = new Map<string, string>(); // lid → phone_jid

    // Phase 1: Collect union of all mappings from every instance
    for (const inst of instances) {
      const result = deps.dbReader.query(inst.name, inst.dbPath, (db: DatabaseSync) => {
        return db.prepare('SELECT lid, phone_jid FROM lid_mappings').all() as Array<{ lid: string; phone_jid: string }>;
      });
      if (result.ok) {
        for (const m of result.data) {
          allMappings.set(m.lid, m.phone_jid);
        }
      }
    }

    // Phase 2: Write the union set into every instance's DB (needs writable access)
    const results: Record<string, number> = {};
    for (const inst of instances) {
      const insertResult = deps.dbReader.queryWrite(inst.name, inst.dbPath, (db: DatabaseSync) => {
        // Wrap in a transaction — without this, each INSERT is a separate WAL write
        // which is both slow and creates contention with the running instance.
        db.prepare('BEGIN').run();
        try {
          const stmt = db.prepare(
            `INSERT OR IGNORE INTO lid_mappings (lid, phone_jid, updated_at)
             VALUES (?, ?, datetime('now'))`,
          );
          let imported = 0;
          for (const [lid, phoneJid] of allMappings) {
            const r = stmt.run(lid, phoneJid);
            if ((r as any).changes > 0) imported++;
          }
          db.prepare('COMMIT').run();
          return imported;
        } catch (err) {
          db.prepare('ROLLBACK').run();
          throw err;
        }
      });
      results[inst.name] = insertResult.ok ? insertResult.data : -1;
    }

    const totalMappings = allMappings.size;
    log.info({ totalMappings, results }, 'L5: cross-instance LID sync completed');
    jsonResponse(res, 200, { totalMappings, results });
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
  const staticHandler = createStaticHandler(distDir, deps.fleetToken, getVersion);
  // Realtime publisher is wired after wsServer creation — use a deferred reference
  let realtimePublish: (event: import('./websocket-server.ts').WsEvent) => void = () => {};
  const realtime: FleetRealtimePublisher = { publish: (event) => realtimePublish(event) };
  const routeDeps: RouteDeps = { discovery, healthPoller, dbReader, realtime, log, updateChecker };

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];

    // API routes require auth
    if (pathname.startsWith('/api/')) {
      // Accept Bearer header or ?token= query param (EventSource can't set headers)
      const queryToken = parseQueryString(url).token ?? '';
      const tokenMatch = queryToken.length === deps.fleetToken.length &&
        crypto.timingSafeEqual(Buffer.from(queryToken), Buffer.from(deps.fleetToken));
      if (!checkBearerAuth(req, deps.fleetToken) && !tokenMatch) {
        jsonResponse(res, 401, { error: 'unauthorized' });
        return;
      }

      for (const route of ROUTES) {
        const params = parseRoute(method, url, route);
        if (params) {
          if (hasNameParam(route.handler)) {
            if (typeof params.name !== 'string') continue;
            await handlers[route.handler](req, res, routeDeps, { name: params.name });
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
      log.error({ err }, 'unhandled fleet request error');
      try {
        jsonResponse(res, 500, { error: 'internal error' });
      } catch { /* response already started */ }
    });
  });

  // WebSocket server for real-time console updates
  const wsServer = new FleetWebSocketServer(server, deps.fleetToken);

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
      server.listen(port, '127.0.0.1', () => {
        log.info({ port, ws: true }, 'fleet server listening');
      });
    },
    stop(): void {
      realtimePoller.stop();
      healthPoller.stop();
      discovery.stop();
      updateChecker.stop();
      wsServer.close();
      server.close();
    },
  };
}
