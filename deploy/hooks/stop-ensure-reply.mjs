#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasVisibleReply, inspectTranscript } from './lib/transcript-walk.mjs';
import {
  appendQueueEntry,
  defaultSocketPath,
  logLine,
  resolveInstanceName,
  sessionStateDir,
  stuckRepliesQueuePath,
} from './lib/rgp-state.mjs';

const MAX_RECENT_ERRORS = 3;
const MAX_ERROR_EXCERPT_CHARS = 240;

function readStdin() {
  return new Promise((resolve) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      body += chunk;
      if (body.length > 512 * 1024) process.stdin.destroy();
    });
    process.stdin.on('end', () => resolve(body));
    process.stdin.on('error', () => resolve(body));
  });
}

function markerPath(sessionId) {
  return join(sessionStateDir(sessionId), 'whatsapp-fallback-queued');
}

function readRecentErrors(sessionId) {
  const path = join(sessionStateDir(sessionId), 'errors.jsonl');
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-MAX_RECENT_ERRORS)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          return [{
            toolName: typeof entry.toolName === 'string' ? entry.toolName : 'unknown-tool',
            excerpt: typeof entry.excerpt === 'string'
              ? entry.excerpt.slice(0, MAX_ERROR_EXCERPT_CHARS)
              : '',
          }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function composeFallback(errors) {
  const lines = [
    'Still working on this. My session ended before I could send a complete reply, so I queued a recovery follow-up.',
  ];
  if (errors.length > 0) {
    const last = errors[errors.length - 1];
    lines.push(`Last blocker: ${last.toolName}${last.excerpt ? ` - ${last.excerpt}` : ''}`);
  }
  return lines.join('\n');
}

function shouldSkip(payload) {
  if (payload.hook_event_name && payload.hook_event_name !== 'Stop') return true;
  if (payload.stop_hook_active === true) return true;
  return false;
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw || '{}');
    if (shouldSkip(payload)) return;

    const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim()
      : 'unknown-session';
    const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    const chatJid = typeof process.env.WHATSOUP_CHAT_JID === 'string' ? process.env.WHATSOUP_CHAT_JID.trim() : '';
    const instance = resolveInstanceName();
    const hookLog = join(sessionStateDir(sessionId), 'stop-ensure-reply.log');

    if (!transcriptPath || !chatJid) {
      logLine(hookLog, { event: 'skip', reason: 'missing-context', hasTranscriptPath: Boolean(transcriptPath), hasChatJid: Boolean(chatJid) });
      return;
    }

    const inspection = inspectTranscript(transcriptPath);
    if (hasVisibleReply(inspection)) {
      logLine(hookLog, { event: 'skip', reason: 'visible-reply', inspection });
      return;
    }

    const marker = markerPath(sessionId);
    if (existsSync(marker)) {
      logLine(hookLog, { event: 'skip', reason: 'already-queued' });
      return;
    }

    const errors = readRecentErrors(sessionId);
    const entry = {
      kind: 'stuck-reply',
      status: 'queued',
      createdAt: new Date().toISOString(),
      sessionId,
      chatJid,
      instance,
      socketPath: process.env.WHATSOUP_MCP_SOCKET || defaultSocketPath(),
      transcriptPath,
      inspection,
      recentErrors: errors,
      text: composeFallback(errors),
    };

    if (appendQueueEntry(stuckRepliesQueuePath(instance), entry)) {
      writeFileSync(marker, `${entry.createdAt}\n`, { mode: 0o600 });
      logLine(hookLog, { event: 'queued', queue: stuckRepliesQueuePath(instance), sessionId });
    } else {
      logLine(hookLog, { event: 'queue-failed', sessionId });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      logLine(join(sessionStateDir('unknown-session'), 'stop-ensure-reply.log'), { event: 'hook-error', message });
    } catch {
      // Stop hook must not block the caller path.
    }
  }
}

await main();
