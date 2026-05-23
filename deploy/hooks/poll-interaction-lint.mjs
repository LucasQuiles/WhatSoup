#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logLine, sessionStateDir } from './lib/rgp-state.mjs';

const POLL_QUESTION_MAX_CHARS = 900;
const POLL_OPTION_MAX_CHARS = 95;
const LOG_MAX_BYTES = 64 * 1024;
const LOG_MAX_LINES = 200;
const POLL_TOOLS = new Set(['send_poll', 'mcp__whatsoup__send_poll']);
const MESSAGE_TOOLS = new Set([
  'send_message',
  'reply_message',
  'mcp__whatsoup__send_message',
  'mcp__whatsoup__reply_message',
]);

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function excerpt(value) {
  const compact = String(value).replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? compact.slice(0, 237) + '...' : compact;
}

function readPayload() {
  try {
    const input = readFileSync(0, 'utf8').trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function toolNameFor(payload) {
  return asString(payload.tool_name || payload.toolName || payload.name);
}

function toolInputFor(payload) {
  return asObject(payload.tool_input || payload.toolInput || payload.input || payload.arguments);
}

function sessionIdFor(payload) {
  return asString(payload.session_id || payload.sessionId || payload.transcript_id || payload.transcriptId) || 'unknown-session';
}

function textCandidates(input) {
  const direct = [input.text, input.message, input.content, input.body, input.caption].filter((value) => typeof value === 'string');
  if (direct.length > 0) return direct;
  return [];
}

function lintMessage(input) {
  const findings = [];
  const asksForStatusReply = /\b(type|reply|send|text|message|respond)\b[\s\S]{0,120}\b(i\s+voted|done voting|voted)\b/i;
  for (const text of textCandidates(input)) {
    if (asksForStatusReply.test(text)) {
      findings.push({ code: 'asks-user-to-type-i-voted', excerpt: excerpt(text) });
    }
  }
  return findings;
}

function normalizeOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((option) => String(option));
}

function lintPoll(input) {
  const findings = [];
  const question = asString(input.question).trim();
  const options = normalizeOptions(input.options);

  if (!question) findings.push({ code: 'blank-poll-question' });
  if (question.length > POLL_QUESTION_MAX_CHARS) {
    findings.push({ code: 'long-poll-question', excerpt: excerpt(question) });
  }

  const seen = new Map();
  options.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) findings.push({ code: 'blank-poll-option', optionIndex: index });
    if (trimmed.length > POLL_OPTION_MAX_CHARS) {
      findings.push({ code: 'long-poll-option', optionIndex: index, excerpt: excerpt(trimmed) });
    }
    const key = trimmed.toLowerCase();
    if (key) {
      if (seen.has(key)) {
        findings.push({ code: 'duplicate-poll-option', optionIndex: index, firstOptionIndex: seen.get(key), excerpt: excerpt(trimmed) });
      } else {
        seen.set(key, index);
      }
    }
  });

  if (Object.prototype.hasOwnProperty.call(input, 'selectableCount')) {
    const selectableCount = input.selectableCount;
    if (!Number.isInteger(selectableCount) || selectableCount < 1 || selectableCount > options.length) {
      findings.push({ code: 'invalid-selectable-count', excerpt: excerpt(selectableCount) });
    }
  }

  return findings;
}

function trimLog(path) {
  try {
    if (!existsSync(path)) return;
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') <= LOG_MAX_BYTES) return;
    const lines = text.split('\n').filter(Boolean).slice(-LOG_MAX_LINES);
    writeFileSync(path, lines.length > 0 ? lines.join('\n') + '\n' : '', { mode: 0o600 });
  } catch {
    // Hook diagnostics must never affect tool execution.
  }
}

function main() {
  const payload = readPayload();
  if (!payload || typeof payload !== 'object') return;

  const toolName = toolNameFor(payload);
  const input = toolInputFor(payload);
  let findings = [];

  if (POLL_TOOLS.has(toolName)) findings = lintPoll(input);
  if (MESSAGE_TOOLS.has(toolName)) findings = lintMessage(input);
  if (findings.length === 0) return;

  const sessionId = sessionIdFor(payload);
  const logPath = join(sessionStateDir(sessionId), 'poll-interaction-lint.jsonl');
  logLine(logPath, {
    event: 'poll-interaction-lint',
    createdAt: new Date().toISOString(),
    sessionId,
    toolName,
    findings,
  });
  trimLog(logPath);
}

try {
  main();
} catch {
  // Fail open: this hook is diagnostic-only.
}
