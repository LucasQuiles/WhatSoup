import {
  chmodSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, hostname, platform, release } from 'node:os';
import { join } from 'node:path';

export type BotErrorsSeverity = 'critical' | 'error' | 'warning' | 'info';
export type BotErrorsEventType = 'alert' | 'clear';

export interface BotErrorsOutboxInput {
  eventType: BotErrorsEventType;
  instance: string;
  source: string;
  summary: string;
  evidence?: string;
  severity?: BotErrorsSeverity;
}

export interface BotErrorsOutboxWrite {
  eventId: string;
  path: string;
}

const SECRETISH_ASSIGNMENT =
  /\b(api[_-]?key|token|secret|password|authorization|cookie|credential)\b(\s*[:=]\s*)(["']?)[^\s"',}]+/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const URL_USERINFO = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

function redactText(value: string): string {
  return value
    .replace(PEM_PRIVATE_KEY, '[REDACTED PEM PRIVATE KEY]')
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .replace(AWS_ACCESS_KEY_ID, '[REDACTED AWS ACCESS KEY]')
    .replace(GITHUB_TOKEN, '[REDACTED GITHUB TOKEN]')
    .replace(JWT_VALUE, '[REDACTED JWT]')
    .replace(SECRETISH_ASSIGNMENT, (_match, key: string, sep: string, quote: string) => `${key}${sep}${quote}[REDACTED]`)
    .replace(BEARER_VALUE, 'Bearer [REDACTED]');
}

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'unknown';
}

function nowIso(): string {
  return new Date().toISOString();
}

function stateDir(): string {
  return process.env['BOT_ERRORS_STATE_DIR'] ?? join(homedir(), '.local', 'state', 'bot-errors');
}

export function botErrorsOutboxDir(): string {
  return process.env['BOT_ERRORS_OUTBOX_DIR'] ?? join(stateDir(), 'outbox');
}

function hostPlatform(): string {
  return process.env['BOT_ERRORS_DRY_PLATFORM'] ?? platform();
}

function hostRelease(): string {
  return process.env['BOT_ERRORS_DRY_PLATFORM_RELEASE'] ?? release();
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function relevantEnvKeys(): string[] {
  const patterns = [
    /^LOG_DIR$/,
    /^NODE_ENV$/,
    /^WHATSOUP_/,
    /^BOT_ERRORS_/,
    /^XDG_/,
    /^SYSTEMD_/,
    /^INVOCATION_ID$/,
  ];

  return Object.keys(process.env)
    .filter((key) => patterns.some((pattern) => pattern.test(key)))
    .filter((key) => !/(TOKEN|SECRET|KEY|PASSWORD|COOKIE|CREDENTIAL)/i.test(key))
    .sort();
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function logPredicateQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function logHints(instance: string): string[] {
  const hints = new Set<string>();
  const logDir = process.env['LOG_DIR'];
  if (logDir) hints.add(join(logDir, 'whatsoup.log'));

  const osPlatform = hostPlatform();
  const osRelease = hostRelease().toLowerCase();
  const isWsl = osPlatform === 'linux' && osRelease.includes('microsoft');

  if (osPlatform === 'darwin') {
    if (instance) {
      hints.add(`launchctl print gui/$(id -u)/${instance}`);
      hints.add(`log show --last 30m --predicate 'eventMessage CONTAINS "${logPredicateQuote(instance)}"'`);
    }
    hints.add('launchctl print gui/$(id -u)/com.bot-errors.dispatcher');
    hints.add(`log show --last 30m --predicate 'process == "bot-errors-dispatcher"'`);
    return [...hints];
  }

  if (isWsl) {
    if (instance) {
      hints.add(`ps -eo pid,etime,cmd | grep -F ${shellSingleQuote(instance)}`);
    }
    hints.add(join(homedir(), '.claude', 'observability', 'runtime'));
    hints.add(join(homedir(), '.claude', 'observability', 'sessions'));
    hints.add(join(stateDir(), 'logs', 'dispatch.jsonl'));
    return [...hints];
  }

  if (instance) hints.add(`journalctl --user -u whatsoup@${instance}.service --since '30 minutes ago'`);
  hints.add(`journalctl --user -u bot-errors-dispatcher.service --since '30 minutes ago'`);
  return [...hints];
}

export function buildBotErrorsEvent(input: BotErrorsOutboxInput, eventId = randomUUID(), createdAt = nowIso()) {
  const instance = input.instance.trim() || 'unknown';
  const source = input.source.trim() || 'unknown';
  const summary = input.summary.trim() || `${input.eventType} event from ${source}`;
  const evidence = input.evidence?.trim() ?? '';

  return {
    schemaVersion: 1,
    id: eventId,
    eventType: input.eventType,
    severity: input.severity ?? (input.eventType === 'clear' ? 'info' : 'critical'),
    createdAt,
    machine: hostname(),
    platform: `${hostPlatform()} ${hostRelease()}`,
    instance,
    source,
    summary: redactText(summary),
    evidence: redactText(evidence),
    process: {
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      argv: process.argv.map(redactText),
      execPath: process.execPath,
      node: process.version,
    },
    runtime: {
      envKeys: relevantEnvKeys(),
      invocationId: process.env['INVOCATION_ID'] ?? null,
      systemdExecPid: process.env['SYSTEMD_EXEC_PID'] ?? null,
    },
    diagnostics: {
      logHints: logHints(instance),
      queue: botErrorsOutboxDir(),
    },
    delivery: {
      attempts: 0,
      status: 'queued',
      nextAttemptAtEpoch: 0,
      lastError: null,
    },
  };
}

export function writeBotErrorsEvent(input: BotErrorsOutboxInput): BotErrorsOutboxWrite {
  const outbox = botErrorsOutboxDir();
  ensurePrivateDir(outbox);

  const event = buildBotErrorsEvent(input);
  const created = event.createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const fileName = `${created}.${safeSegment(event.instance)}.${safeSegment(event.source)}.${event.id}.json`;
  const finalPath = join(outbox, fileName);
  const tmpPath = join(outbox, `.${fileName}.${process.pid}.tmp`);
  const payload = `${JSON.stringify(event, null, 2)}\n`;

  try {
    writeFileSync(tmpPath, payload, { mode: 0o600, flag: 'wx' });
    renameSync(tmpPath, finalPath);
    chmodSync(finalPath, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; the caller handles the write failure.
    }
    throw err;
  }

  return { eventId: event.id, path: finalPath };
}
