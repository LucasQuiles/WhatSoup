#!/usr/bin/env node
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname, platform, release, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { sessionStateDir } from './lib/rgp-state.mjs';

const MAX_ERROR_LOG_BYTES = 64 * 1024;
const MAX_ERROR_LOG_LINES = 200;
const MAX_EXCERPT_CHARS = 800;
const MAX_EVIDENCE_CHARS = 4000;
const MAX_INPUT_SUMMARY_CHARS = 300;
const SECRETISH_ASSIGNMENT =
  /\b(api[_-]?key|token|secret|password|authorization|cookie|credential)\b(\s*[:=]\s*)(["']?)[^\s"',}]+/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const URL_USERINFO = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

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
    .replace(PEM_PRIVATE_KEY, '[REDACTED PEM PRIVATE KEY]')
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .replace(AWS_ACCESS_KEY_ID, '[REDACTED AWS ACCESS KEY]')
    .replace(GITHUB_TOKEN, '[REDACTED GITHUB TOKEN]')
    .replace(JWT_VALUE, '[REDACTED JWT]')
    .replace(SECRETISH_ASSIGNMENT, (_match, key, sep, quote) => `${key}${sep}${quote}[REDACTED]`)
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
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

const STRONG_TEST_SIGNAL_KEYS = ['VITEST', 'VITEST_WORKER_ID', 'JEST_WORKER_ID', 'PYTEST_CURRENT_TEST'];

function envValue(key) {
  const value = process.env[key];
  return value && value.trim() ? value : undefined;
}

function strongTestSignals() {
  return STRONG_TEST_SIGNAL_KEYS.filter((key) => envValue(key));
}

function provenanceSignals() {
  const signals = strongTestSignals();
  if ((process.env.NODE_ENV || '').trim().toLowerCase() === 'test') signals.push('NODE_ENV');
  return [...new Set(signals)].sort();
}

function testStateDir() {
  if (strongTestSignals().length === 0) return null;
  const cwdHash = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
  const worker = safeSegment(envValue('VITEST_WORKER_ID') || envValue('JEST_WORKER_ID') || `pid-${process.pid}`);
  return join(process.env.TMPDIR || tmpdir(), 'whatsoup-vitest-bot-errors', `${cwdHash}.${worker}`);
}

function stateDir() {
  return envValue('BOT_ERRORS_STATE_DIR') || testStateDir() || join(homedir(), '.local', 'state', 'bot-errors');
}

function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

function liveOutboxCandidates() {
  return [
    join(homedir(), '.local', 'state', 'bot-errors', 'outbox'),
    envValue('BOT_ERRORS_LIVE_OUTBOX_DIR'),
  ].filter(Boolean).map(canonicalPath);
}

function testLiveOutboxAllowed() {
  return /^(1|true|yes|on)$/i.test(process.env.BOT_ERRORS_ALLOW_TEST_LIVE_OUTBOX || '');
}

function resolveOutboxDir() {
  const explicitOutbox = envValue('BOT_ERRORS_OUTBOX_DIR');
  const explicitState = envValue('BOT_ERRORS_STATE_DIR');
  const testState = testStateDir();
  let outbox = join(homedir(), '.local', 'state', 'bot-errors', 'outbox');
  let policy = 'default';
  if (explicitOutbox) {
    outbox = explicitOutbox;
    policy = 'explicit-outbox';
  } else if (explicitState) {
    outbox = join(explicitState, 'outbox');
    policy = 'explicit-state';
  } else if (testState) {
    outbox = join(testState, 'outbox');
    policy = 'test-default';
  }
  const originalOutbox = outbox;
  if (
    strongTestSignals().length > 0
    && !testLiveOutboxAllowed()
    && liveOutboxCandidates().includes(canonicalPath(outbox))
  ) {
    outbox = join(testState || join(process.env.TMPDIR || tmpdir(), 'whatsoup-vitest-bot-errors', `pid-${process.pid}`), 'outbox');
    policy = 'test-redirect';
  }
  return { outbox, policy, redirected: outbox !== originalOutbox };
}

function outboxDir() {
  return resolveOutboxDir().outbox;
}

function provenance(resolution) {
  const strongSignals = strongTestSignals();
  return {
    producer: 'post-tool-use-hook',
    test: strongSignals.length > 0,
    signals: provenanceSignals(),
    strongSignals,
    outboxPolicy: resolution.policy,
    liveOutboxRedirected: resolution.redirected,
    resolvedOutbox: resolution.outbox,
  };
}

function writefailDirs() {
  return [...new Set([
    process.env.BOT_ERRORS_WRITEFAIL_DIR,
    join(stateDir(), 'writefail'),
    join(homedir(), '.bot-errors-writefail'),
    join(process.env.TMPDIR || tmpdir(), 'bot-errors-writefail'),
  ].filter(Boolean))];
}

function safeSegment(value) {
  const cleaned = String(value).trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'unknown').slice(0, 80);
}

function safeFileName(value, maxLength = 180) {
  const cleaned = String(value).trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  if (cleaned.length <= maxLength) return cleaned;
  for (const suffix of ['.writefail', '.json']) {
    if (cleaned.endsWith(suffix) && suffix.length < maxLength) {
      const stem = cleaned.slice(0, maxLength - suffix.length).replace(/[._:-]+$/g, '') || 'unknown';
      return `${stem}${suffix}`;
    }
  }
  return cleaned.slice(0, maxLength);
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best-effort hardening only; hook telemetry must not block the caller path.
  }
}

function safeChildPath(directory, name) {
  ensurePrivateDir(directory);
  const first = join(directory, safeFileName(name));
  const stem = safeFileName(name, 140);
  const prefix = `${Math.floor(Date.now() / 1000)}.${process.pid}`;
  const candidates = [
    first,
    ...Array.from({ length: 1000 }, (_value, index) => join(directory, `${prefix}.${index}.${stem}`)),
  ];
  for (const target of candidates) {
    let fd;
    try {
      fd = openSync(target, 'wx', 0o600);
      return target;
    } catch {
      continue;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
        try {
          unlinkSync(target);
        } catch {
          // The following atomic write owns the final path.
        }
      }
    }
  }
  throw new Error(`no available child path in ${directory}: ${name}`);
}

function fsyncPath(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(path) {
  try {
    fsyncPath(path);
  } catch {
    // Some platforms/filesystems do not allow fsync on directories.
  }
}

function writeJsonAtomic(path, payload) {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fsyncPath(tmpPath);
    renameSync(tmpPath, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort.
    }
    fsyncDir(dirname(path));
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort.
    }
    throw err;
  }
}

function recordWritefail(event, err, failedTarget) {
  const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  try {
    process.stderr.write(
      `[post-tool-use-log] CRITICAL outbox write FAILED for ${sanitize(failedTarget)}: ${sanitize(reason)}; ` +
      `id=${event.id} instance=${event.instance} source=${event.source} severity=${event.severity} - recording breadcrumb\n`,
    );
  } catch {
    // Last-resort trace only.
  }

  const breadcrumb = {
    schemaVersion: 1,
    kind: 'outbox_write_failure',
    recordedAt: new Date().toISOString(),
    failedTarget: sanitize(failedTarget),
    reason: sanitize(reason),
    emitPid: process.pid,
    event,
  };
  const created = breadcrumb.recordedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const fileName = `${created}.${safeSegment(event.instance)}.${safeSegment(event.id)}.writefail`;
  for (const directory of writefailDirs()) {
    try {
      const path = safeChildPath(directory, fileName);
      writeJsonAtomic(path, breadcrumb);
      try {
        process.stderr.write(`[post-tool-use-log] lost-alert breadcrumb written: ${path}\n`);
      } catch {
        // Best effort.
      }
      return path;
    } catch {
      continue;
    }
  }

  try {
    process.stderr.write(
      `[post-tool-use-log] breadcrumb write failed in ALL fallback dirs; lost-event payload follows:\n${JSON.stringify(event)}\n`,
    );
  } catch {
    // Best effort.
  }
  return null;
}

function writeEventFile(event, outboxResolution = resolveOutboxDir()) {
  const outbox = outboxResolution.outbox;
  const created = event.createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const fileName = `${created}.${safeSegment(event.instance)}.${safeSegment(event.source)}.${event.id}.json`;
  const finalPath = join(outbox, fileName);
  const tmpPath = join(outbox, `.${fileName}.${process.pid}.tmp`);
  try {
    ensurePrivateDir(outbox);
    writeFileSync(tmpPath, `${JSON.stringify(event, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fsyncPath(tmpPath);
    renameSync(tmpPath, finalPath);
    try {
      chmodSync(finalPath, 0o600);
    } catch {
      // Best effort.
    }
    fsyncDir(outbox);
    return finalPath;
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort.
    }
    recordWritefail(event, err, outbox);
    throw err;
  }
}

function diagnosticEnvKeys() {
  return Object.keys(process.env)
    .filter((key) => /^(BOT_ERRORS_|WHATSOUP_|CLAUDE_|XDG_|NODE_ENV$|LOG_DIR$)/.test(key))
    .filter((key) => !/(TOKEN|SECRET|KEY|PASSWORD|COOKIE|CREDENTIAL)/i.test(key))
    .sort();
}

function valueAt(record, names) {
  for (const name of names) {
    if (typeof record?.[name] === 'string' && record[name].trim()) return record[name].trim();
  }
  return '';
}

function sourceFor(toolName, hookEvent) {
  const base = hookEvent === 'PostToolUseFailure' ? 'hook-tool-call-failed' : 'hook-tool-result-error';
  return `${base}:${safeSegment(toolName)}`;
}

function buildEvidence(payload, entry, sessionLogPath) {
  const lines = [
    `hook_event=${payload.hook_event_name || 'PostToolUse'}`,
    `session_id=${entry.sessionId}`,
    `tool_name=${entry.toolName}`,
    `tool_use_id=${valueAt(payload, ['tool_use_id', 'toolUseId']) || 'unknown'}`,
    `cwd=${valueAt(payload, ['cwd']) || process.cwd()}`,
    `transcript_path=${valueAt(payload, ['transcript_path', 'transcriptPath']) || 'unknown'}`,
    `agent_id=${valueAt(payload, ['agent_id', 'agentId']) || 'main'}`,
    `agent_type=${valueAt(payload, ['agent_type', 'agentType']) || 'unknown'}`,
    `duration_ms=${payload.duration_ms ?? payload.durationMs ?? 'unknown'}`,
    `whatsoup_instance=${process.env.WHATSOUP_INSTANCE || 'unknown'}`,
    `whatsoup_chat_jid=${process.env.WHATSOUP_CHAT_JID || payload.tool_input?.chatJid || payload.toolInput?.chatJid || 'unknown'}`,
    `input_summary=${entry.inputSummary || 'none'}`,
    `session_error_log=${sessionLogPath}`,
    'error_excerpt:',
    entry.excerpt || 'unknown',
  ];
  return truncate(lines.join('\n'), MAX_EVIDENCE_CHARS);
}

function botErrorLogHints(instance, payload, sessionLogPath) {
  const hints = [
    sessionLogPath,
    valueAt(payload, ['transcript_path', 'transcriptPath']),
    join(stateDir(), 'logs'),
  ].filter(Boolean);
  if (platform() === 'darwin') {
    hints.push(`launchctl print gui/$(id -u)/${instance}`);
    hints.push(`log show --last 30m --predicate 'eventMessage CONTAINS "${instance.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"'`);
  } else {
    hints.push(`journalctl --user -u whatsoup@${instance}.service --since '30 minutes ago'`);
    hints.push("journalctl --user -u bot-errors-dispatcher.service --since '30 minutes ago'");
  }
  return [...new Set(hints)].slice(0, 8);
}

function writeBotErrorsAlert(payload, entry, sessionLogPath) {
  if (process.env.BOT_ERRORS_TOOL_FAILURE_ALERTS === '0') return null;
  const hookEvent = payload.hook_event_name || 'PostToolUse';
  if (hookEvent !== 'PostToolUseFailure' && process.env.BOT_ERRORS_POST_TOOL_USE_ALERTS !== '1') return null;
  const instance = process.env.WHATSOUP_INSTANCE || valueAt(payload, ['instance']) || 'agent-tool';
  const source = sourceFor(entry.toolName, hookEvent);
  const outboxResolution = resolveOutboxDir();
  const event = {
    schemaVersion: 2,
    eventKind: 'incident_alert',
    id: `tool-${safeSegment(entry.sessionId)}-${safeSegment(entry.toolName)}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    eventType: 'alert',
    severity: 'error',
    createdAt: new Date().toISOString(),
    machine: hostname(),
    platform: `${platform()} ${release()}`,
    instance,
    source,
    summary: sanitize(`Agent tool failure: ${entry.toolName}`),
    evidence: sanitize(buildEvidence(payload, entry, sessionLogPath)),
    process: {
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      argv: process.argv.map(sanitize),
      execPath: process.execPath,
      node: process.version,
    },
    runtime: {
      envKeys: diagnosticEnvKeys(),
      hookEvent: payload.hook_event_name || 'PostToolUse',
      permissionMode: payload.permission_mode || null,
      effort: payload.effort || null,
      provenance: provenance(outboxResolution),
    },
    diagnostics: {
      logHints: botErrorLogHints(instance, payload, sessionLogPath),
      queue: outboxResolution.outbox,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      toolUseId: valueAt(payload, ['tool_use_id', 'toolUseId']) || '',
      agentId: valueAt(payload, ['agent_id', 'agentId']),
      agentType: valueAt(payload, ['agent_type', 'agentType']),
    },
    delivery: {
      attempts: 0,
      status: 'queued',
      nextAttemptAtEpoch: 0,
      lastError: null,
    },
  };
  return writeEventFile(event, outboxResolution);
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
    if (payload.hook_event_name && !['PostToolUse', 'PostToolUseFailure'].includes(payload.hook_event_name)) return;

    const response = payload.hook_event_name === 'PostToolUseFailure'
      ? { is_error: true, content: payload.error ?? payload.message ?? payload.tool_error }
      : payload.tool_response ?? payload.toolResponse ?? payload.result;
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
    try {
      writeBotErrorsAlert(payload, entry, path);
    } catch (err) {
      appendJsonLine(path, {
        event: 'bot-errors-alert-failed',
        createdAt: new Date().toISOString(),
        message: sanitize(err instanceof Error ? err.message : String(err)),
      });
    }
  } catch {
    // PostToolUse diagnostics are best-effort and must degrade softly.
  }
}

await main();
