import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createChildLogger } from '../logger.ts';
import { jsonResponse, checkBearerAuth, parseRoute, parseQueryString, readBody } from '../lib/http.ts';
import { FleetDiscovery } from './discovery.ts';
import { HealthPoller } from './health-poller.ts';
import { FleetDbReader } from './db-reader.ts';
import { createStaticHandler } from './static.ts';
import { handleGetLines, handleGetLine } from './routes/lines.ts';
import { handleGetChats, handleGetMessages, handleGetAccess, handleGetLogs, handleGetTyping, handleCheckExists } from './routes/data.ts';
import { handleSend, handleAccessUpdate, handleRestart, handleStop, handleConfigUpdate, handleCreateLine, handleAuth } from './routes/ops.ts';
import { handleGetFeed } from './routes/feed.ts';
import type { DatabaseSync } from 'node:sqlite';

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
  log: typeof log;
}

// ---------------------------------------------------------------------------
// Handler dispatch map
// ---------------------------------------------------------------------------

type HandlerFn = (
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
  params: Record<string, string>,
) => void | Promise<void>;

const handlers: Record<string, HandlerFn> = {
  getLines:     (req, res, deps, _params) => handleGetLines(req, res, deps),
  getLine:      (req, res, deps, params) => handleGetLine(req, res, deps, params as any),
  getChats:     (req, res, deps, params) => handleGetChats(req, res, deps, params as any),
  getMessages:  (req, res, deps, params) => handleGetMessages(req, res, deps, params as any),
  getAccess:    (req, res, deps, params) => handleGetAccess(req, res, deps, params as any),
  getLogs:      (req, res, deps, params) => handleGetLogs(req, res, deps, params as any),
  send:         (req, res, deps, params) => handleSend(req, res, deps, params as any),
  accessUpdate: (req, res, deps, params) => handleAccessUpdate(req, res, deps, params as any),
  restart:      (req, res, deps, params) => handleRestart(req, res, deps, params as any),
  stop:         (req, res, deps, params) => handleStop(req, res, deps, params as any),
  configUpdate: (req, res, deps, params) => handleConfigUpdate(req, res, deps, params as any),
  getTyping:    (req, res, deps, _params) => handleGetTyping(req, res, deps),
  getFeed:      (req, res, deps, _params) => handleGetFeed(req, res, deps),
  createLine:   (req, res, deps, _params) => handleCreateLine(req, res, deps),
  checkExists:  (req, res, deps, params) => handleCheckExists(req, res, deps, params as any),
  auth:         (req, res, deps, params) => handleAuth(req, res, deps, params as any),
};

// ---------------------------------------------------------------------------
// Fleet token management
// ---------------------------------------------------------------------------

/** Load or create the fleet token at ~/.config/whatsoup/fleet-token */
export async function loadOrCreateFleetToken(): Promise<string> {
  const tokenPath = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'whatsoup',
    'fleet-token',
  );

  try {
    return fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    const token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
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
  { method: 'GET',   path: /^\/api\/lines$/, handler: 'getLines' },
  { method: 'POST',  path: /^\/api\/lines$/, handler: 'createLine' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/exists$/, handler: 'checkExists' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)$/, handler: 'getLine' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/chats$/, handler: 'getChats' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/messages$/, handler: 'getMessages' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/access$/, handler: 'getAccess' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/logs$/, handler: 'getLogs' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/send$/, handler: 'send' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/access$/, handler: 'accessUpdate' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/restart$/, handler: 'restart' },
  { method: 'POST',  path: /^\/api\/lines\/(?<name>[^/]+)\/stop$/, handler: 'stop' },
  { method: 'PATCH', path: /^\/api\/lines\/(?<name>[^/]+)\/config$/, handler: 'configUpdate' },
  { method: 'GET',   path: /^\/api\/lines\/(?<name>[^/]+)\/auth$/, handler: 'auth' },
] as const;

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
  const staticHandler = createStaticHandler(distDir);

  const routeDeps: RouteDeps = { discovery, healthPoller, dbReader, log };

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
          const handler = handlers[route.handler];
          if (handler) {
            await handler(req, res, routeDeps, params);
            return;
          }
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

  return {
    server,
    discovery,
    healthPoller,
    dbReader,
    start(port: number): void {
      discovery.startAutoRefresh();
      healthPoller.start();
      server.listen(port, '127.0.0.1', () => {
        log.info({ port }, 'fleet server listening');
      });
    },
    stop(): void {
      healthPoller.stop();
      discovery.stop();
      server.close();
    },
  };
}
