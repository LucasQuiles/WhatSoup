import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, hostname, platform, release, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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
const PHONE_LIKE = /(^|[^\w])(\+?(?:\d[\d\s().-]{8,}\d))(?![\w])/g;

function redactPhoneLike(value: string): string {
  return value.replace(PHONE_LIKE, (match, prefix: string, candidate: string) => {
    const digits = candidate.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15 ? `${prefix}[REDACTED PHONE]` : match;
  });
}

function redactText(value: string): string {
  return redactPhoneLike(value
    .replace(PEM_PRIVATE_KEY, '[REDACTED PEM PRIVATE KEY]')
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .replace(AWS_ACCESS_KEY_ID, '[REDACTED AWS ACCESS KEY]')
    .replace(GITHUB_TOKEN, '[REDACTED GITHUB TOKEN]')
    .replace(JWT_VALUE, '[REDACTED JWT]')
    .replace(SECRETISH_ASSIGNMENT, (_match, key: string, sep: string, quote: string) => `${key}${sep}${quote}[REDACTED]`)
    .replace(BEARER_VALUE, 'Bearer [REDACTED]'));
}

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'unknown';
}

function safeFileName(value: string, maxLength = 180): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  if (cleaned.length <= maxLength) return cleaned;
  for (const suffix of ['.writefail', '.json']) {
    if (cleaned.endsWith(suffix) && suffix.length < maxLength) {
      const stem = cleaned.slice(0, maxLength - suffix.length).replace(/[._:-]+$/g, '') || 'unknown';
      return `${stem}${suffix}`;
    }
  }
  return cleaned.slice(0, maxLength);
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

function writefailDirs(): string[] {
  const candidates = [
    process.env['BOT_ERRORS_WRITEFAIL_DIR'],
    join(stateDir(), 'writefail'),
    join(homedir(), '.bot-errors-writefail'),
    join(process.env['TMPDIR'] ?? tmpdir(), 'bot-errors-writefail'),
  ].filter((path): path is string => Boolean(path));

  return [...new Set(candidates)];
}

function safeChildPath(directory: string, name: string): string {
  ensurePrivateDir(directory);
  const first = join(directory, safeFileName(name));
  const stem = safeFileName(name, 140);
  const prefix = `${Math.floor(Date.now() / 1000)}.${process.pid}`;
  const candidates = [
    first,
    ...Array.from({ length: 1000 }, (_value, index) => join(directory, `${prefix}.${index}.${stem}`)),
  ];
  for (const target of candidates) {
    let fd: number | undefined;
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

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(path: string): void {
  try {
    fsyncPath(path);
  } catch {
    // Some platforms/filesystems do not allow fsync on directories.
  }
}

function writeJsonAtomic(path: string, payload: unknown): void {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fsyncPath(tmpPath);
    renameSync(tmpPath, path);
    chmodSync(path, 0o600);
    fsyncDir(dirname(path));
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; the caller handles the write failure.
    }
    throw err;
  }
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

export function recordBotErrorsWritefail(
  event: ReturnType<typeof buildBotErrorsEvent>,
  err: unknown,
  failedTarget: string,
): string | null {
  const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  try {
    process.stderr.write(
      `[bot-errors-ts] CRITICAL outbox write FAILED for ${failedTarget}: ${redactText(reason)}; ` +
      `id=${event.id} instance=${event.instance} source=${event.source} severity=${event.severity} - recording breadcrumb\n`,
    );
  } catch {
    // Stderr is a last-resort trace and must never mask the original write failure.
  }
  const breadcrumb = {
    schemaVersion: 1,
    kind: 'outbox_write_failure',
    recordedAt: nowIso(),
    failedTarget,
    reason: redactText(reason),
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
        process.stderr.write(`[bot-errors-ts] lost-alert breadcrumb written: ${path}\n`);
      } catch {
        // Best effort only.
      }
      return path;
    } catch {
      continue;
    }
  }

  try {
    process.stderr.write(
      `[bot-errors-ts] breadcrumb write failed in ALL fallback dirs; lost-event payload follows:\n${JSON.stringify(event)}\n`,
    );
  } catch {
    // Best effort only.
  }
  return null;
}

export function writeBotErrorsEvent(input: BotErrorsOutboxInput): BotErrorsOutboxWrite {
  const outbox = botErrorsOutboxDir();
  const event = buildBotErrorsEvent(input);
  const created = event.createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const fileName = `${created}.${safeSegment(event.instance)}.${safeSegment(event.source)}.${event.id}.json`;
  const finalPath = join(outbox, fileName);
  const tmpPath = join(outbox, `.${fileName}.${process.pid}.tmp`);
  const payload = `${JSON.stringify(event, null, 2)}\n`;

  try {
    ensurePrivateDir(outbox);
    writeFileSync(tmpPath, payload, { mode: 0o600, flag: 'wx' });
    fsyncPath(tmpPath);
    renameSync(tmpPath, finalPath);
    chmodSync(finalPath, 0o600);
    fsyncDir(outbox);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; the caller handles the write failure.
    }
    recordBotErrorsWritefail(event, err, outbox);
    throw err;
  }

  return { eventId: event.id, path: finalPath };
}
