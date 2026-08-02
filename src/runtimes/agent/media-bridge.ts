// src/runtimes/agent/media-bridge.ts
// Unix domain socket server that bridges Claude Code subprocess media sends to Messenger.sendMedia().
// Ported from legacy whatsapp-bot/src/runtimes/agent/media-bridge.ts.

import { createServer, type Server, type Socket } from 'node:net';
import { statSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve, extname, dirname, basename, join } from 'node:path';
import { z } from 'zod';
import type { Messenger, OutboundMedia } from '../../core/types.ts';
import { destroyOutboundMediaStream } from '../../core/media-stream.ts';
import { isPathWithinAllowedRoot } from '../../mcp/types.ts';
import { createChildLogger } from '../../logger.ts';
import { isBaileysEncryptedTmpEnoent, createMediaReadStream } from '../../transport/baileys-media-errors.ts';

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

function buildOutboundMediaFromPath(
  mediaType: MediaType,
  resolvedPath: string,
  filename: string,
  mimetype: string,
  caption: string | undefined,
  allowedRoot: string,
): OutboundMedia {
  switch (mediaType) {
    case 'image':
      return { type: 'image', stream: createMediaReadStream(resolvedPath, allowedRoot, log), mimetype, caption };
    case 'audio':
      return { type: 'audio', stream: createMediaReadStream(resolvedPath, allowedRoot, log), mimetype };
    case 'video':
      return { type: 'video', stream: createMediaReadStream(resolvedPath, allowedRoot, log), mimetype, caption };
    default:
      return { type: 'document', stream: createMediaReadStream(resolvedPath, allowedRoot, log), filename, mimetype, caption };
  }
}

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
  // isPathWithinAllowedRoot canonicalizes only the ROOT. The candidate path is
  // canonicalized by this file, in handleRequest below, via
  // `join(realpathSync(dirname(resolvedInput)), basename(resolvedInput))`.
  // (This comment previously said canonicalization happened inside the helper;
  // it does not, and the code here is only safe because it realpaths the
  // candidate itself.)

  const MAX_BUF = 1_024 * 1_024; // 1 MB — match WhatSoupSocketServer's limit
  const activeSockets = new Set<Socket>();

  const server = createServer((socket) => {
    activeSockets.add(socket);
    // QR-053: UTF-8-decode the line-delimited JSON-RPC stream so a multibyte char
    // split across a read boundary isn't silently corrupted to U+FFFD (the bytes here
    // are file PATHS in JSON, not raw media — the media flows via the filesystem).
    socket.setEncoding('utf8');
    let buf = '';

    socket.on('close', () => {
      activeSockets.delete(socket);
    });

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
        handleRequest(trimmed, messenger, allowedRoot, bridge)
          .catch((err): BridgeResponse => {
            // A rejection here would otherwise escape as an unhandledRejection
            // (fatal at the process level) and leave the agent-side client
            // waiting on the socket forever.
            log.error({ err }, 'media bridge request handler failed');
            return { ok: false, error: 'internal error' };
          })
          .then((response) => {
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
    for (const socket of activeSockets) {
      socket.destroy();
    }
    activeSockets.clear();
    server.close(() => {
      try { unlinkSync(socketPath); } catch { /* already gone */ }
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

interface BridgeResponse {
  ok: boolean;
  error?: string;
}

/**
 * Shape schema for the *request-body prefix* handleRequest can express as
 * pure validation: `path` (required, non-empty string) plus the two
 * optional, non-rejecting string fields `caption`/`filename`. `chatJid` is
 * deliberately not modeled — the handler never reads it from the parsed
 * body (see setMediaBridgeChat/bridge._currentChatJid; a request-level
 * chatJid is intentionally ignored), so validating it here would add a
 * rejection mode the original ladder never had. Everything past this
 * prefix (realpathSync canonicalization, isPathWithinAllowedRoot,
 * statSync) depends on the filesystem and bridge state, not the request
 * body, and stays hand-rolled below — per Tier-B lane 1
 * (tierb-contract-lane-spec-r15 §1.5), only this prefix is expressible as
 * a schema.
 *
 * Per-node `message` options reproduce the original ladder's literal
 * `'missing path'` string exactly, regardless of which sub-condition
 * (missing/wrong-type/empty) fired — this schema has exactly one
 * rejectable field, so there is no first-failure-among-competing-messages
 * ordering to resolve here (contrast with multi-message ladders elsewhere
 * in the Tier-B set).
 *
 * `caption`/`filename` use `.optional().catch(undefined)` rather than a
 * bare `.optional()`: the original ladder silently drops a wrong-typed
 * optional field to `undefined` instead of rejecting the whole request,
 * and a bare `.optional()` would reject on a wrong type instead of
 * matching that cast-through behavior.
 *
 * The `z.object(...)` call also carries `invalid_type_error: 'missing
 * path'` — the original ladder reached `req.path` via plain property
 * access, which is safe (returns `undefined`) on any non-null JS value
 * including primitives and arrays, so a non-object root (e.g. a bare
 * `"42"` or `[]` request line) fell through to the same 'missing path'
 * branch as an object with no `path` key. Without this override, zod's
 * object-shape check would reject a non-object root with its own generic
 * "Expected object, received ..." message before ever reaching the `path`
 * field check — a byte-for-byte drift the equivalence net catches.
 */
const BridgeRequestShapeSchema = z.object(
  {
    path: z
      .string({ required_error: 'missing path', invalid_type_error: 'missing path' })
      .min(1, { message: 'missing path' }),
    caption: z.string().optional().catch(undefined),
    filename: z.string().optional().catch(undefined),
  },
  { invalid_type_error: 'missing path' },
);

async function handleRequest(
  rawLine: string,
  messenger: Messenger,
  allowedRoot: string,
  bridge: MediaBridge,
): Promise<BridgeResponse> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawLine);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }

  // Legacy trap, preserved on purpose: a literal JSON `null` body used to
  // crash on `req.path` property access (JS `.` access on null throws,
  // while access on any other primitive/array is a safe `undefined`). That
  // uncaught TypeError propagated to the outer socket handler's `.catch`,
  // which maps it to `{ok:false, error:'internal error'}`. zod's
  // safeParse would otherwise absorb `null` gracefully and answer
  // 'missing path' instead — a real behavior change — so the crash path
  // stays explicit rather than being silently fixed by the conversion.
  if (parsedJson === null) {
    throw new TypeError('media bridge request body is null');
  }

  const shape = BridgeRequestShapeSchema.safeParse(parsedJson);
  if (!shape.success) {
    return { ok: false, error: shape.error.issues[0]?.message ?? 'missing path' };
  }
  const filePath = shape.data.path;

  // Canonicalize the incoming filePath so the boundary check is symmetric
  // across /var/folders vs /private/var/folders on macOS. realpathSync throws
  // on non-existent paths — canonicalize the parent directory + basename so
  // the downstream readFile still produces "file not found" instead of
  // "path not allowed".
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(filePath);
  } catch {
    try {
      const resolvedInput = resolve(filePath);
      resolvedPath = join(realpathSync(dirname(resolvedInput)), basename(resolvedInput));
    } catch {
      resolvedPath = resolve(filePath);
    }
  }
  if (!isPathWithinAllowedRoot(resolvedPath, allowedRoot)) {
    log.warn({ resolvedPath, allowedRoot }, 'path not allowed');
    return { ok: false, error: 'path not allowed' };
  }

  const chatJid = bridge._currentChatJid;

  if (!chatJid) {
    return { ok: false, error: 'current chat is required' };
  }

  try {
    statSync(resolvedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, error: `file not found: ${resolvedPath}` };
    log.error({ err, resolvedPath }, 'failed to stat file');
    return { ok: false, error: 'failed to read file' };
  }

  // Infer media type and mimetype from extension
  const ext = extname(resolvedPath).toLowerCase();
  const mediaType: MediaType = EXT_TO_TYPE[ext] ?? 'document';
  const mimetype = EXT_TO_MIME[ext] ?? 'application/octet-stream';
  const caption = shape.data.caption;
  const filename = shape.data.filename ?? basename(resolvedPath) ?? 'file';

  for (let attempt = 0; ; attempt += 1) {
    const media = buildOutboundMediaFromPath(mediaType, resolvedPath, filename, mimetype, caption, allowedRoot);
    try {
      await messenger.sendMedia(chatJid, media);
      log.info({ chatJid, mediaType, ext }, 'media sent');
      return { ok: true };
    } catch (err) {
      destroyOutboundMediaStream(media);
      if (attempt === 0 && isBaileysEncryptedTmpEnoent(err)) {
        log.warn(
          { err, chatJid, mediaType, path: err.path },
          'baileys encrypted tmp file vanished during media bridge send; retrying with fresh stream',
        );
        continue;
      }
      log.error({ err, chatJid }, 'sendMedia failed');
      return { ok: false, error: 'failed to send media — try again' };
    }
  }
}
