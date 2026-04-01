import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { readBody, jsonResponse } from '../../lib/http.ts';
import { mcpCall } from '../mcp-client.ts';
import { proxyToInstance } from '../http-proxy.ts';
import type { FleetDiscovery } from '../discovery.ts';

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
  const instance = deps.discovery.getInstance(params.name);
  if (!instance) {
    jsonResponse(res, 404, { error: `instance '${params.name}' not found` });
    return;
  }

  const body = await readBody(req);

  // Mode-aware routing
  if ((instance.type === 'passive' || instance.type === 'agent') && instance.socketPath) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      jsonResponse(res, 400, { error: 'invalid JSON body' });
      return;
    }
    // Auto-append WhatsApp JID suffix if missing (console sends conversation keys without @)
    if (typeof parsed.chatJid === 'string' && !parsed.chatJid.includes('@')) {
      parsed.chatJid = parsed.chatJid.includes('_at_g.us')
        ? parsed.chatJid.replace('_at_g.us', '@g.us')  // group conversation key
        : `${parsed.chatJid}@s.whatsapp.net`;           // personal JID
    }
    const result = await mcpCall(instance.socketPath, 'send_message', parsed);
    jsonResponse(res, result.success ? 200 : 502, result);
    return;
  }

  if (instance.type === 'chat') {
    // Auto-append JID suffix for chat-mode proxy too
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
    const result = await proxyToInstance(
      instance.healthPort, '/send', 'POST', fixedBody, instance.healthToken,
    );
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
    return;
  }

  jsonResponse(res, 422, {
    error: `no send route available for instance '${params.name}' (type=${instance.type}, socketPath=${instance.socketPath ?? 'none'})`,
  });
}

/** POST /api/lines/:name/access — proxy access update to instance. */
export async function handleAccessUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  const instance = deps.discovery.getInstance(params.name);
  if (!instance) {
    jsonResponse(res, 404, { error: `instance '${params.name}' not found` });
    return;
  }

  const body = await readBody(req);
  const result = await proxyToInstance(
    instance.healthPort, '/access', 'POST', body, instance.healthToken,
  );
  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(result.body);
}

/** POST /api/lines/:name/restart — restart the systemd user unit. */
export async function handleRestart(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  const instance = deps.discovery.getInstance(params.name);
  if (!instance) {
    jsonResponse(res, 404, { error: `instance '${params.name}' not found` });
    return;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('systemctl', ['--user', 'restart', `whatsoup@${params.name}`], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    jsonResponse(res, 202, { status: 'restart_requested', instance: params.name });
  } catch (err) {
    jsonResponse(res, 500, {
      error: `restart failed: ${(err as Error).message}`,
      instance: params.name,
    });
  }
}

/** PATCH /api/lines/:name/config — merge fields into instance config. */
export async function handleConfigUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  const instance = deps.discovery.getInstance(params.name);
  if (!instance) {
    jsonResponse(res, 404, { error: `instance '${params.name}' not found` });
    return;
  }

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

  // Shallow merge
  const merged = { ...existing, ...patch };

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
