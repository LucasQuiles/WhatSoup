// src/runtimes/agent/media-bridge.ts
// Unix domain socket server that bridges Claude Code subprocess media sends to Messenger.sendMedia().
// Ported from legacy whatsapp-bot/src/runtimes/agent/media-bridge.ts.

import { createServer, type Server } from 'node:net';
import { readFile, access } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import type { Messenger, OutboundMedia } from '../../core/types.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('media-bridge');

// ─── Extension maps ───────────────────────────────────────────────────────────

type MediaType = OutboundMedia['type'];

const EXT_TO_TYPE: Record<string, MediaType> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.pdf': 'document',
  '.doc': 'document',
  '.docx': 'document',
  '.xlsx': 'document',
  '.csv': 'document',
  '.txt': 'document',
  '.zip': 'document',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.m4a': 'audio',
  '.wav': 'audio',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
};

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

// ─── Bridge handle ────────────────────────────────────────────────────────────

/**
 * Opaque handle returned by startMediaBridge.
 * Calling it stops the server; setMediaBridgeChat sets the current chat.
 */
export interface MediaBridge {
  (): void;
  _server: Server;
  _currentChatJid: string | null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the Unix socket media bridge.
 *
 * @param socketPath  Path for the Unix domain socket (created on listen).
 * @param messenger   Messenger instance to forward media through.
 * @param allowedRoot All file paths in requests must be under this directory.
 * @returns A MediaBridge handle — call it to stop the server.
 */
export function startMediaBridge(
  socketPath: string,
  messenger: Messenger,
  allowedRoot: string,
): MediaBridge {
  const resolvedRoot = resolve(allowedRoot);

  const MAX_BUF = 1_024 * 1_024; // 1 MB — match WhatSoupSocketServer's limit

  const server = createServer((socket) => {
    let buf = '';

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      if (buf.length > MAX_BUF) {
        log.warn('media bridge buffer limit exceeded — closing socket');
        socket.destroy();
        return;
      }
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        handleRequest(trimmed, messenger, resolvedRoot, bridge).then((response) => {
          try {
            socket.write(JSON.stringify(response) + '\n');
          } catch (err) {
            log.error({ err }, 'failed to write response to socket');
          }
        });
      }
    });

    socket.on('error', (err) => {
      log.error({ err }, 'socket error');
    });
  });

  // Remove stale socket from prior crash before listening
  try { unlinkSync(socketPath); } catch { /* not found — fine */ }

  server.listen(socketPath, () => {
    log.info({ socketPath }, 'media bridge listening');
  });

  server.on('error', (err) => {
    log.error({ err }, 'media bridge server error');
  });

  const cleanup = function () {
    server.close(() => {
      log.info({ socketPath }, 'media bridge closed');
    });
  } as MediaBridge;

  cleanup._server = server;
  cleanup._currentChatJid = null;

  const bridge = cleanup;
  return bridge;
}

/**
 * Set the current turn's target chat on a bridge.
 * Used so callers don't have to pass chatJid in every request.
 */
export function setMediaBridgeChat(bridge: MediaBridge, chatJid: string): void {
  bridge._currentChatJid = chatJid;
}

// ─── Request handler ──────────────────────────────────────────────────────────

interface BridgeRequest {
  path?: unknown;
  chatJid?: unknown;
  caption?: unknown;
  filename?: unknown;
}

interface BridgeResponse {
  ok: boolean;
  error?: string;
}

async function handleRequest(
  rawLine: string,
  messenger: Messenger,
  resolvedRoot: string,
  bridge: MediaBridge,
): Promise<BridgeResponse> {
  let req: BridgeRequest;
  try {
    req = JSON.parse(rawLine) as BridgeRequest;
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }

  const filePath = typeof req.path === 'string' ? req.path : null;
  if (!filePath) {
    return { ok: false, error: 'missing path' };
  }

  // Resolve and validate against allowed root
  const resolvedPath = resolve(filePath);
  if (!resolvedPath.startsWith(resolvedRoot + '/') && resolvedPath !== resolvedRoot) {
    log.warn({ resolvedPath, resolvedRoot }, 'path not allowed');
    return { ok: false, error: 'path not allowed' };
  }

  // Determine chatJid
  const chatJid =
    typeof req.chatJid === 'string'
      ? req.chatJid
      : bridge._currentChatJid;

  if (!chatJid) {
    return { ok: false, error: 'chatJid is required (not in request and no current chat set)' };
  }

  // Check file exists and read it
  try {
    await access(resolvedPath);
  } catch {
    return { ok: false, error: `file not found: ${resolvedPath}` };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(resolvedPath);
  } catch (err) {
    log.error({ err, resolvedPath }, 'failed to read file');
    return { ok: false, error: `failed to read file: ${(err as Error).message}` };
  }

  // Infer media type and mimetype from extension
  const ext = extname(resolvedPath).toLowerCase();
  const mediaType: MediaType = EXT_TO_TYPE[ext] ?? 'document';
  const mimetype = EXT_TO_MIME[ext] ?? 'application/octet-stream';
  const caption = typeof req.caption === 'string' ? req.caption : undefined;
  const filename =
    typeof req.filename === 'string'
      ? req.filename
      : resolvedPath.split('/').pop() ?? 'file';

  let media: OutboundMedia;
  switch (mediaType) {
    case 'image':
      media = { type: 'image', buffer, mimetype, caption };
      break;
    case 'audio':
      media = { type: 'audio', buffer, mimetype };
      break;
    case 'video':
      media = { type: 'video', buffer, mimetype, caption };
      break;
    default:
      media = { type: 'document', buffer, filename, mimetype, caption };
      break;
  }

  try {
    await messenger.sendMedia(chatJid, media);
    log.info({ chatJid, mediaType, ext }, 'media sent');
    return { ok: true };
  } catch (err) {
    log.error({ err, chatJid }, 'sendMedia failed');
    return { ok: false, error: `sendMedia failed: ${(err as Error).message}` };
  }
}
