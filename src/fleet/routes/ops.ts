import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { readBody, jsonResponse, requireInstance } from '../../lib/http.ts';
import { createChildLogger } from '../../logger.ts';
const log = createChildLogger('fleet:ops');
import { mcpCall } from '../mcp-client.ts';
import { proxyToInstance } from '../http-proxy.ts';
import type { FleetDiscovery } from '../discovery.ts';
import { configRoot, dataRoot, stateRoot } from '../paths.ts';

export interface OpsDeps {
  discovery: FleetDiscovery;
}

/** POST /api/lines/:name/send — route a message to the instance. */
export async function handleSend(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const body = await readBody(req);

  // Normalize JID in request body
  let fixedBody = body;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.chatJid === 'string' && !parsed.chatJid.includes('@')) {
      parsed.chatJid = parsed.chatJid.includes('_at_g.us')
        ? parsed.chatJid.replace('_at_g.us', '@g.us')
        : `${parsed.chatJid}@s.whatsapp.net`;
      fixedBody = JSON.stringify(parsed);
    }
  } catch { /* use original body */ }

  // Route 1: Try MCP socket (passive instances with verified socket)
  if (instance.type === 'passive' && instance.socketPath) {
    try {
      const socketStat = fs.existsSync(instance.socketPath!);
      if (socketStat) {
        const parsed = JSON.parse(fixedBody);
        const result = await mcpCall(instance.socketPath, 'send_message', parsed);
        jsonResponse(res, result.success ? 200 : 502, result);
        return;
      }
    } catch { /* fall through to HTTP */ }
  }

  // Route 2: HTTP health server /send (works for ALL instance types)
  // This is the universal fallback — every instance has a health port
  if (instance.healthPort) {
    const result = await proxyToInstance(
      instance.healthPort, '/send', 'POST', fixedBody, instance.healthToken,
    );
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
    return;
  }

  jsonResponse(res, 422, {
    error: `no send route available for instance '${params.name}' (type=${instance.type})`,
  });
}

/** POST /api/lines/:name/access — proxy access update to instance. */
export async function handleAccessUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const body = await readBody(req);
  const result = await proxyToInstance(
    instance.healthPort, '/access', 'POST', body, instance.healthToken,
  );
  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(result.body);
}

/** Shared systemctl action handler for restart/stop. */
async function handleSystemctlAction(
  verb: 'restart' | 'stop',
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  try {
    await execFileAsync('systemctl', ['--user', verb, `whatsoup@${params.name}`]);
    jsonResponse(res, 202, { status: `${verb}_requested`, instance: params.name });
  } catch (err) {
    jsonResponse(res, 500, {
      error: `${verb} failed: ${(err as Error).message}`,
      instance: params.name,
    });
  }
}

/** POST /api/lines/:name/restart — restart the systemd user unit. */
export async function handleRestart(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  return handleSystemctlAction('restart', res, deps, params);
}

/** POST /api/lines/:name/stop — stop the systemd user unit. */
export async function handleStop(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  return handleSystemctlAction('stop', res, deps, params);
}

/** PATCH /api/lines/:name/config — merge fields into instance config. */
export async function handleConfigUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const body = await readBody(req);
  let patch: Record<string, unknown>;
  try {
    patch = JSON.parse(body);
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error('body must be a JSON object');
    }
  } catch (err) {
    jsonResponse(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
    return;
  }

  // Read existing config
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(fs.readFileSync(instance.configPath, 'utf-8'));
  } catch (err) {
    jsonResponse(res, 500, { error: `failed to read config: ${(err as Error).message}` });
    return;
  }

  // Deep merge for known nested objects so partial patches don't destroy siblings
  const DEEP_MERGE_KEYS = ['agentOptions', 'models'];
  const merged = { ...existing, ...patch };
  for (const key of DEEP_MERGE_KEYS) {
    if (existing[key] && patch[key] && typeof existing[key] === 'object' && typeof patch[key] === 'object') {
      merged[key] = { ...(existing[key] as Record<string, unknown>), ...(patch[key] as Record<string, unknown>) };
    }
  }

  // Validate cwd path traversal (same guard as handleCreateLine)
  if (merged.agentOptions && typeof (merged.agentOptions as Record<string, unknown>).cwd === 'string') {
    const cwd = (merged.agentOptions as Record<string, unknown>).cwd as string;
    if (cwd.trim()) {
      const safeCwd = path.resolve(cwd);
      if (!safeCwd.startsWith(os.homedir() + path.sep)) {
        jsonResponse(res, 400, { error: 'agentOptions.cwd must be within the home directory' });
        return;
      }
      (merged.agentOptions as Record<string, unknown>).cwd = safeCwd;
    }
  }

  // Validate numeric bounds if present in patch
  if (typeof patch.rateLimitPerHour === 'number' && (patch.rateLimitPerHour < 1 || patch.rateLimitPerHour > 10000)) {
    jsonResponse(res, 400, { error: 'rateLimitPerHour must be between 1 and 10,000' });
    return;
  }
  if (typeof patch.maxTokens === 'number' && (patch.maxTokens < 256 || patch.maxTokens > 200000)) {
    jsonResponse(res, 400, { error: 'maxTokens must be between 256 and 200,000' });
    return;
  }
  if (typeof patch.tokenBudget === 'number' && (patch.tokenBudget < 1000 || patch.tokenBudget > 10000000)) {
    jsonResponse(res, 400, { error: 'tokenBudget must be between 1,000 and 10,000,000' });
    return;
  }

  // Write CLAUDE.md BEFORE committing config.json so both succeed or neither does
  if (patch.claudeMd && merged.type === 'agent') {
    const ao = merged.agentOptions as Record<string, unknown> | undefined;
    if (ao && typeof ao.cwd === 'string' && ao.cwd.trim()) {
      try {
        const claudeDir = path.join(ao.cwd, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), patch.claudeMd as string, 'utf-8');
      } catch (err) {
        jsonResponse(res, 500, { error: `failed to write CLAUDE.md: ${(err as Error).message}` });
        return;
      }
    }
  }

  // Atomic write: write to .tmp then rename
  const tmpPath = instance.configPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, instance.configPath);
  } catch (err) {
    // Clean up tmp on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    jsonResponse(res, 500, { error: `failed to write config: ${(err as Error).message}` });
    return;
  }

  jsonResponse(res, 200, merged);
}

/** DELETE /api/lines/:name — tear down and remove an instance completely.
 *  Idempotent: returns 200 even if the instance was already deleted. */
export async function handleDeleteLine(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  // Defense-in-depth: validate name format before any fs/systemd operations
  if (!NAME_RE.test(params.name)) {
    jsonResponse(res, 400, { error: 'invalid instance name' });
    return;
  }

  // 1. Stop the systemd unit (ignore failure — may already be stopped/gone)
  try { await execFileAsync('systemctl', ['--user', 'stop', `whatsoup@${params.name}`]); } catch { /* ok */ }

  // 2. Disable the systemd unit (ignore failure — may not be enabled)
  try { await execFileAsync('systemctl', ['--user', 'disable', `whatsoup@${params.name}`]); } catch { /* ok */ }

  // 3. Remove config, data, and state directories
  cleanupPartial(params.name);

  // 4. Re-scan discovery so the instance disappears from the UI
  deps.discovery.scan();

  jsonResponse(res, 200, { deleted: params.name });
}

// ---------------------------------------------------------------------------
// Helpers for handleCreateLine
// ---------------------------------------------------------------------------

/** Scan all existing config.json files for healthPort values. */
function usedHealthPorts(): number[] {
  const root = configRoot();
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch { return []; }
  const ports: number[] = [];
  for (const name of entries) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(root, name, 'config.json'), 'utf-8'));
      if (typeof raw.healthPort === 'number') ports.push(raw.healthPort);
    } catch { /* skip unreadable configs */ }
  }
  return ports;
}

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/** Remove directories/files created during a partial instance creation. */
function cleanupPartial(name: string, extraPaths?: string[]): void {
  const dirs = [
    path.join(configRoot(), name),
    path.join(dataRoot(name)),
    path.join(stateRoot(name)),
  ];
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (extraPaths) {
    for (const p of extraPaths) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// POST /api/lines — create a new instance
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const VALID_TYPES = new Set(['passive', 'chat', 'agent']);

/** POST /api/lines — create a new WhatSoup instance. */
export async function handleCreateLine(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
): Promise<void> {
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('body must be a JSON object');
    }
  } catch (err) {
    jsonResponse(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
    return;
  }

  // --- Validate name ---
  const name = body.name;
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.length < 2 || name.length > 30) {
    jsonResponse(res, 400, { error: 'name must be 2-30 lowercase alphanumeric/hyphens, starting with a letter' });
    return;
  }

  // --- Uniqueness check ---
  const configDir = path.join(configRoot(), name);
  if (deps.discovery.getInstance(name) != null || fs.existsSync(configDir)) {
    jsonResponse(res, 409, { error: `instance '${name}' already exists` });
    return;
  }

  // --- Validate type ---
  const type = body.type as string;
  if (!VALID_TYPES.has(type)) {
    jsonResponse(res, 400, { error: `type must be one of: passive, chat, agent` });
    return;
  }

  // --- Validate & deduplicate adminPhones ---
  let adminPhones = body.adminPhones;
  if (!Array.isArray(adminPhones) || adminPhones.length === 0 ||
      adminPhones.some((p: unknown) => typeof p !== 'string' || p === '')) {
    jsonResponse(res, 400, { error: 'adminPhones must be a non-empty array of non-empty strings' });
    return;
  }
  adminPhones = [...new Set((adminPhones as string[]).map((p: string) => p.replace(/\D/g, '')))];

  // --- Type-specific validation ---
  // systemPrompt and agentOptions are deferred — validated at instance start by instance-loader.
  // At create time they may not be set yet (wizard sends them via PATCH after QR link).
  // Only block passive instances from having a systemPrompt (hard constraint).
  if (type === 'passive' && body.systemPrompt) {
    jsonResponse(res, 400, { error: 'passive instances must not have a systemPrompt' });
    return;
  }

  // --- Auto-assign healthPort ---
  let healthPort = typeof body.healthPort === 'number' ? body.healthPort as number : null;
  if (healthPort == null) {
    const used = usedHealthPorts();
    healthPort = used.length > 0 ? Math.max(...used) + 1 : 9095;
  }

  // --- Validate accessMode ---
  const VALID_ACCESS_MODES = new Set(['self_only', 'allowlist', 'open_dm', 'groups_only']);
  const accessMode = type === 'passive' ? 'self_only' : (body.accessMode ?? 'self_only') as string;
  if (!VALID_ACCESS_MODES.has(accessMode)) {
    jsonResponse(res, 400, { error: 'accessMode must be one of: self_only, allowlist, open_dm, groups_only' });
    return;
  }

  // --- Validate agent-specific options (only if provided — may come via PATCH later) ---
  if (type === 'agent' && body.agentOptions) {
    const ao = body.agentOptions as Record<string, unknown>;
    if (typeof ao !== 'object') {
      jsonResponse(res, 400, { error: 'agentOptions must be an object' });
      return;
    }
    const VALID_SCOPES = new Set(['single', 'shared', 'per_chat']);
    if (ao.sessionScope && !VALID_SCOPES.has(ao.sessionScope as string)) {
      jsonResponse(res, 400, { error: 'agentOptions.sessionScope must be single, shared, or per_chat' });
      return;
    }
    if (ao.sessionScope === 'single' && accessMode !== 'self_only') {
      jsonResponse(res, 400, { error: 'agent with sessionScope "single" requires accessMode "self_only"' });
      return;
    }
    // Confine cwd to user home directory if provided
    if (typeof ao.cwd === 'string' && ao.cwd.trim()) {
      const safeCwd = path.resolve(ao.cwd as string);
      if (!safeCwd.startsWith(os.homedir() + path.sep)) {
        jsonResponse(res, 400, { error: 'agentOptions.cwd must be within the home directory' });
        return;
      }
      (body.agentOptions as Record<string, unknown>).cwd = safeCwd;
    }
  }

  // --- Build config — start with validated required fields, then merge optional fields ---
  const config: Record<string, unknown> = {
    name,
    type,
    adminPhones,
    healthPort,
    accessMode,
    introSent: false, // triggers introduction message on first boot
  };

  // --- Validate numeric bounds ---
  if (typeof body.rateLimitPerHour === 'number' && (body.rateLimitPerHour < 1 || body.rateLimitPerHour > 10000)) {
    jsonResponse(res, 400, { error: 'rateLimitPerHour must be between 1 and 10,000' });
    return;
  }
  if (typeof body.maxTokens === 'number' && (body.maxTokens < 256 || body.maxTokens > 200000)) {
    jsonResponse(res, 400, { error: 'maxTokens must be between 256 and 200,000' });
    return;
  }
  if (typeof body.tokenBudget === 'number' && (body.tokenBudget < 1000 || body.tokenBudget > 10000000)) {
    jsonResponse(res, 400, { error: 'tokenBudget must be between 1,000 and 10,000,000' });
    return;
  }

  // Pass through all optional config fields (exclude internal/UI-only fields)
  const PASSTHROUGH_FIELDS = [
    'description', 'systemPrompt', 'maxTokens', 'tokenBudget', 'rateLimitPerHour',
    'models', 'pineconeIndex', 'pineconeSearchMode', 'pineconeRerank', 'pineconeTopK',
    'pineconeAllowedIndexes', 'agentOptions', 'toolUpdateMode', 'controlPeers',
  ];
  for (const field of PASSTHROUGH_FIELDS) {
    if (body[field] != null) config[field] = body[field];
  }

  // --- Create directories ---
  const createdExtras: string[] = [];
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(dataRoot(name), 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dataRoot(name), 'media', 'tmp'), { recursive: true });
    fs.mkdirSync(stateRoot(name), { recursive: true });

    // --- Write config.json ---
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8');

    // TODO: Store per-instance API key in keyring if body.apiKey is provided.
    // The deploy wrapper currently reads a shared key from `secret-tool lookup service anthropic`.
    // Per-instance keys would need `secret-tool store ... service anthropic user <name>`.

    // --- Copy shared health token ---
    try {
      const token = await execFileAsync('secret-tool', ['lookup', 'service', 'whatsoup_health']);
      if (token) {
        fs.writeFileSync(path.join(configDir, 'tokens.env'), `WHATSOUP_HEALTH_TOKEN=${token}\n`, { mode: 0o600 });
      }
    } catch { /* keyring unavailable — skip token */ }

    // --- Write CLAUDE.md for agent instances ---
    if (body.claudeMd && type === 'agent' && body.agentOptions &&
        typeof (body.agentOptions as Record<string, unknown>).cwd === 'string') {
      const cwd = (body.agentOptions as Record<string, unknown>).cwd as string;
      const claudeDir = path.join(cwd, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
      fs.writeFileSync(claudeMdPath, body.claudeMd as string, 'utf-8');
      createdExtras.push(claudeMdPath);
    }

    // --- Enable systemd unit ---
    await execFileAsync('systemctl', ['--user', 'enable', `whatsoup@${name}`]);

    // --- Re-scan discovery ---
    deps.discovery.scan();

    jsonResponse(res, 201, { name, healthPort });
  } catch (err) {
    cleanupPartial(name, createdExtras);
    jsonResponse(res, 500, { error: `instance creation failed: ${(err as Error).message}` });
  }
}

// Active auth processes per instance — prevents duplicate concurrent auth sessions
const activeAuthProcesses = new Map<string, ReturnType<typeof spawn>>();

// Auth session wall-clock timeout (5 minutes — QR codes expire in ~60s, allows 5 scan attempts)
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const ALLOWED_SSE_EVENTS = new Set(['qr', 'connected', 'error']);

/** GET /api/lines/:name/auth — SSE stream of QR codes from the auth process. */
export async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  // Kill any existing auth process for this instance before starting a new one
  const existing = activeAuthProcesses.get(params.name);
  if (existing) {
    try { existing.kill('SIGTERM'); } catch { /* already exited */ }
    activeAuthProcesses.delete(params.name);
  }

  // SSE headers — write BEFORE stopping the instance to avoid browser timeout
  // during a slow systemd stop (up to TimeoutStopSec=15s)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Stop the running instance so the lock file is released for auth
  try { await execFileAsync('systemctl', ['--user', 'stop', `whatsoup@${params.name}`]); } catch { /* may not be running */ }

  // Spawn auth process
  const child = spawn('node', ['--experimental-strip-types', 'src/bootstrap-auth.ts', params.name], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeAuthProcesses.set(params.name, child);

  // Guard against double res.end() — declared before any event handlers
  let ended = false;
  const endOnce = () => {
    if (!ended) {
      ended = true;
      activeAuthProcesses.delete(params.name);
      clearTimeout(authTimer);
      res.end();
    }
  };
  const writeSSE = (event: string, data: unknown) => {
    if (!ended) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Wall-clock timeout — prevents auth process from hanging forever
  const authTimer = setTimeout(() => {
    writeSSE('error', { message: 'Authentication timed out. QR codes expire after ~60 seconds. Please retry.' });
    child.kill('SIGTERM');
    endOnce();
  }, AUTH_TIMEOUT_MS);

  // Parse stdout for JSON events
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (!ALLOWED_SSE_EVENTS.has(evt.event)) continue;
        writeSSE(evt.event, evt.data ?? {});
        if (evt.event === 'connected') {
          // Reset introSent so the instance sends an introduction on next boot
          try {
            const cfgPath = instance.configPath;
            const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            raw.introSent = false;
            fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
          } catch { /* config write failed — intro won't re-fire but not critical */ }
          execFile('systemctl', ['--user', 'start', `whatsoup@${params.name}`], () => {});
          deps.discovery.scan();
          setTimeout(endOnce, 1000);
        }
      } catch { /* skip non-JSON lines */ }
    }
  });

  // Log stderr from auth process for debugging
  child.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log.info({ instance: params.name, stderr: text.slice(0, 200) }, 'auth process stderr');
  });

  // Forward errors
  child.on('error', (err) => {
    writeSSE('error', { message: err.message });
    endOnce();
  });
  child.on('exit', (code) => {
    if (code !== 0) {
      writeSSE('error', { message: `auth exited with code ${code}` });
    }
    endOnce();
  });

  // Cleanup on client disconnect
  req.on('close', () => {
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, 5000);
    endOnce();
  });
}
