#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callTool } from './lib/whatsoup-mcp-call.mjs';
import {
  defaultSocketPath,
  logLine,
  resolveInstanceName,
  sessionStateDir,
} from './lib/rgp-state.mjs';

const VERIFY_WINDOW_MS = Number(process.env.WHATSOUP_SEND_VERIFY_WINDOW_MS ?? 5 * 60 * 1000);
const MCP_TIMEOUT_MS = Number(process.env.WHATSOUP_SEND_VERIFY_TIMEOUT_MS ?? 2_000);
const SEND_TOOL_NAMES = new Set([
  'send_message',
  'reply_message',
  'mcp__whatsoup__send_message',
  'mcp__whatsoup__reply_message',
]);

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

function safeSegment(value, fallback = 'unknown') {
  const text = String(value ?? '').trim();
  if (!text || text === '.' || text === '..') return fallback;
  return text.replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 160) || fallback;
}

function hookLogPath(sessionId) {
  return join(sessionStateDir(sessionId), 'verify-whatsapp-send.log');
}

function reportPath(sessionId) {
  return join(sessionStateDir(sessionId), 'send-verification.jsonl');
}

function markerPath(sessionId, toolName, chatJid) {
  return join(sessionStateDir(sessionId), `send-verification-${safeSegment(toolName)}-${safeSegment(chatJid)}.reported`);
}

function isSendTool(toolName) {
  return SEND_TOOL_NAMES.has(toolName);
}

function contentText(value, depth = 0) {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => contentText(item, depth + 1)).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return contentText(value.content, depth + 1);
    if (typeof value.error === 'string') return value.error;
    if (typeof value.message === 'string') return value.message;
  }
  return '';
}

function isToolError(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.is_error === true || response.isError === true) return true;
  if (response.error != null) return true;
  const text = contentText(response);
  return /(error:|failed|permission denied|eacces|enoent|invalid parameters)/i.test(text);
}

function pickChatJid(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['chatJid', 'chat_jid', 'jid']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const envChat = process.env.WHATSOUP_CHAT_JID;
  return typeof envChat === 'string' ? envChat.trim() : '';
}

function parseJsonMaybe(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractOutboundRows(result) {
  const candidates = [result, result?.structuredContent];
  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (typeof item?.text === 'string') candidates.push(parseJsonMaybe(item.text));
    }
  }

  for (const candidate of candidates) {
    if (Array.isArray(candidate?.outbound_sends)) return candidate.outbound_sends;
  }
  return [];
}

function parseTimestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const text = value.trim();
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)) {
    return Date.parse(`${text.replace(' ', 'T')}Z`);
  }
  return Number.NaN;
}

function isRecentOutboundRow(row, chatJid, nowMs = Date.now()) {
  if (!row || typeof row !== 'object') return false;
  if (row.chat_jid !== chatJid) return false;
  if (row.status !== 'sent') return false;

  const timestamps = [row.sent_at, row.created_at].map(parseTimestampMs).filter(Number.isFinite);
  if (timestamps.length === 0) return true;
  return timestamps.some((timestamp) => nowMs - timestamp <= VERIFY_WINDOW_MS && timestamp - nowMs <= 30_000);
}

function appendReportOnce({ sessionId, toolName, chatJid, instance, reason }) {
  const marker = markerPath(sessionId, toolName, chatJid);
  if (existsSync(marker)) return false;

  const entry = {
    event: 'send-unverified',
    createdAt: new Date().toISOString(),
    sessionId,
    toolName,
    chatJid,
    instance,
    reason,
  };
  logLine(reportPath(sessionId), entry);
  writeFileSync(marker, entry.createdAt, { mode: 0o600 });
  process.stderr.write(`WhatSoup send verification could not confirm ${toolName} for ${chatJid}: ${reason}\n`);
  return true;
}

function readJsonPayload(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = readJsonPayload(raw);
    if (payload.hook_event_name && payload.hook_event_name !== 'PostToolUse') return;

    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
    if (!isSendTool(toolName)) return;

    const response = payload.tool_response ?? payload.toolResponse ?? payload.result;
    if (isToolError(response)) return;

    const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim()
      : 'unknown-session';
    const chatJid = pickChatJid(payload.tool_input ?? payload.toolInput);
    const instance = resolveInstanceName();
    const logPath = hookLogPath(sessionId);

    if (!chatJid) {
      logLine(logPath, { event: 'skip', reason: 'missing-chat-jid', toolName });
      return;
    }

    const socketPath = process.env.WHATSOUP_MCP_SOCKET || defaultSocketPath();
    const result = await callTool({
      socketPath,
      name: 'read_outbound_sends',
      args: { limit: 25, chatJid },
      timeoutMs: MCP_TIMEOUT_MS,
    });

    if (!result.ok || result.toolError) {
      logLine(logPath, {
        event: 'read-failed',
        toolName,
        chatJid,
        error: result.error ?? 'read_outbound_sends returned tool error',
      });
      return;
    }

    const rows = extractOutboundRows(result.result);
    const verified = rows.some((row) => isRecentOutboundRow(row, chatJid));
    if (verified) {
      logLine(logPath, { event: 'verified', toolName, chatJid, rowsChecked: rows.length });
      return;
    }

    appendReportOnce({
      sessionId,
      toolName,
      chatJid,
      instance,
      reason: rows.length === 0 ? 'no outbound_sends rows returned' : 'no recent sent outbound_sends row matched',
    });
    logLine(logPath, { event: 'unverified', toolName, chatJid, rowsChecked: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      logLine(hookLogPath('unknown-session'), { event: 'hook-error', message });
    } catch {
      // Verification hooks must never block the caller path.
    }
  }
}

await main();
