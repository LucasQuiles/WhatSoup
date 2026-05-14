#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionStateDir } from './lib/rgp-state.mjs';

const MAX_ERROR_LOG_BYTES = 64 * 1024;
const MAX_ERROR_LOG_LINES = 200;
const MAX_EXCERPT_CHARS = 800;
const MAX_INPUT_SUMMARY_CHARS = 300;

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

function sanitize(value) {
  return String(value)
    .replace(/(?:\/Users|\/private\/tmp|\/tmp)\/[^\s"'`]+/g, '<redacted-path>')
    .replace(/\b\+?\d[\d\s().-]{7,}\d\b/g, '<redacted-phone>');
}

function truncate(value, max) {
  const text = sanitize(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function contentText(value, depth = 0) {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => contentText(item, depth + 1)).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    const record = value;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    if (Array.isArray(record.content)) return contentText(record.content, depth + 1);
    if (typeof record.error === 'string') return record.error;
    if (typeof record.message === 'string') return record.message;
  }
  return '';
}

function isErrorResult(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.is_error === true || response.isError === true) return true;
  if (response.error != null) return true;
  const text = contentText(response);
  return /(sandbox_deny|exit code [1-9]|enoent|eacces|permission denied|error:|⚠️ error)/i.test(text);
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return truncate(input.command, MAX_INPUT_SUMMARY_CHARS);
  if (typeof input.file_path === 'string') return truncate(input.file_path, MAX_INPUT_SUMMARY_CHARS);
  if (typeof input.path === 'string') return truncate(input.path, MAX_INPUT_SUMMARY_CHARS);
  try {
    return truncate(JSON.stringify(input), MAX_INPUT_SUMMARY_CHARS);
  } catch {
    return '';
  }
}

function trimErrorLog(path) {
  try {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.size <= MAX_ERROR_LOG_BYTES) return;
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const kept = lines.slice(-MAX_ERROR_LOG_LINES);
    writeFileSync(path, `${kept.join('\n')}\n`, { mode: 0o600 });
  } catch {
    // Hook telemetry must not block the caller path.
  }
}

function appendJsonLine(path, entry) {
  try {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      if (text.length > 0 && !text.endsWith('\n')) appendFileSync(path, '\n', { mode: 0o600 });
    }
  } catch {
    // If the existing file cannot be checked, the append below will handle the failure path.
  }
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw || '{}');
    if (payload.hook_event_name && payload.hook_event_name !== 'PostToolUse') return;

    const response = payload.tool_response ?? payload.toolResponse ?? payload.result;
    if (!isErrorResult(response)) return;

    const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim()
      : 'unknown-session';
    const path = join(sessionStateDir(sessionId), 'errors.jsonl');
    const entry = {
      event: 'tool-error',
      createdAt: new Date().toISOString(),
      sessionId,
      toolName: typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown-tool',
      inputSummary: summarizeInput(payload.tool_input ?? payload.toolInput),
      excerpt: truncate(contentText(response) || JSON.stringify(response), MAX_EXCERPT_CHARS),
    };

    appendJsonLine(path, entry);
    trimErrorLog(path);
  } catch {
    // PostToolUse diagnostics are best-effort and must degrade softly.
  }
}

await main();
