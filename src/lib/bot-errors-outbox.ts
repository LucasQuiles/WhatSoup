import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { forceEnsurePrivateDirectorySync, fsyncDirectory } from './private-fs.ts';
import { jidPattern } from './redaction-patterns.ts';
import { homedir, hostname, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type BotErrorsSeverity = 'critical' | 'error' | 'warning' | 'info';
export type BotErrorsEventType = 'alert' | 'clear';
export type BotErrorsRecoverability =
  | 'auto_recoverable'
  | 'operator_recoverable'
  | 'manual_relink_required'
  | 'manual_repair_required'
  | 'unrecoverable'
  | 'unknown';
export type BotErrorsFailureConfidence = 'suspected' | 'probable' | 'confirmed';
export type BotErrorsCriticalAssetKind =
  | 'whatsapp_linked_device'
  | 'whatsapp_auth_bond'
  | 'credential'
  | 'account_linkage'
  | 'bot_errors_delivery'
  | 'runtime_session';

export interface BotErrorsCriticalAssetDiagnostic {
  asset: {
    kind: BotErrorsCriticalAssetKind;
    instance: string;
    owner?: string;
    path?: string;
    fingerprint?: string;
  };
  failure: {
    code: string;
    domain: string;
    recoverability: BotErrorsRecoverability;
    confidence: BotErrorsFailureConfidence;
    operatorAction: string;
    clearRequirement: string;
  };
  evidenceRefs?: string[];
}

export interface BotErrorsOutboxInput {
  eventType: BotErrorsEventType;
  instance: string;
  source: string;
  summary: string;
  evidence?: string;
  severity?: BotErrorsSeverity;
  criticalAsset?: BotErrorsCriticalAssetDiagnostic;
}

export interface BotErrorsOutboxWrite {
  eventId: string;
  path: string;
}

const SECRETISH_ASSIGNMENT =
  /\b(api[_-]?key|token|secret|password|cookie|credential)\b(\s*[:=]\s*)(["']?)(?:Bearer\s+)?[^\s"',}]+/gi;
const AUTHORIZATION_BEARER = /\bAuthorization:\s*Bearer\s+[^\s"',}]+/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
// JID redaction uses the canonical SSOT `jidPattern()` so the device-suffix
// (`:N`) dimension is never dropped — see `src/lib/redaction-patterns.ts`.
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const URL_USERINFO = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
// Anchored, non-ambiguous prefix (lookbehind-guarded `~`/`/` + single lazy body)
// mirrors CREDENTIAL_PATH_RE in lib/bot_errors_redaction.py. The previous
// `(?:~|/[^\s]+)*` prefix allowed overlapping partitions of a long slash-path,
// which backtracked catastrophically (ReDoS) when the required suffix failed.
const CREDENTIAL_PATH =
  /(?:(?<![A-Za-z0-9._~-])~|(?<![A-Za-z0-9._~-])\/)[^\s"',;}]*?(?:\.config\/secrets\/[^\s"',;}]+|\.config\/whatsoup\/[^\s"',;}]+|\.local\/share\/whatsoup\/instances\/[^\s"',;}]*\/auth(?:\/[^\s"',;}]+)?|auth-bond-backups\/[^\s"',;}]+|\/(?:bot-errors\.env|fleet-token|fleet\.env|fleet-tokens\.json|tokens\.env|secrets\.env|\.env(?:\.[^\s"',;}]+)?))\b/gi;
const KEYED_PHONE_LIKE = /\b(phone|phone[_-]?number|msisdn|line)(\s*[:=]\s*|\s+)(\+?\d{10,16})\b/gi;
const CONTEXT_PHONE_LIKE = /\b(for)(\s+)(\+?\d{10,16})\b/gi;
const PHONE_LIKE = /(^|[^\w])(\+?(?:\d[\d\s().-]{8,}\d))(?![\w])/g;

function redactPhoneLike(value: string): string {
  return value
    .replace(KEYED_PHONE_LIKE, (_match, key: string, sep: string) => `${key}${sep}[REDACTED PHONE]`)
    .replace(CONTEXT_PHONE_LIKE, (_match, key: string, sep: string) => `${key}${sep}[REDACTED PHONE]`)
    .replace(PHONE_LIKE, (match, prefix: string, candidate: string) => {
      const digits = candidate.replace(/\D/g, '');
      const hasPhoneSyntax = candidate.trim().startsWith('+') || /[\s().-]/.test(candidate);
      return hasPhoneSyntax && digits.length >= 10 && digits.length <= 15 ? `${prefix}[REDACTED PHONE]` : match;
    });
}

// Recognizable, non-secret directory categories. When safe-shape is enabled we
// preserve the leading category so an operator can tell WHICH file is missing,
// while the secret leaf is reduced to a redacted marker. None of these prefixes
// is itself a secret (well-known config locations). Mirror of the Python
// _CRED_PATH_SAFE_PREFIXES in lib/bot_errors_redaction.py.
const CRED_PATH_SAFE_PREFIXES = [
  '.config/secrets/',
  '.config/whatsoup/',
  '.local/share/whatsoup/instances/',
  'auth-bond-backups/',
] as const;

function safeShapeCredPathEnabled(): boolean {
  const raw = (process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function safeShapeCredentialPath(matched: string): string {
  for (const prefix of CRED_PATH_SAFE_PREFIXES) {
    const idx = matched.indexOf(prefix);
    if (idx !== -1) {
      return `${matched.slice(0, idx)}${prefix}[REDACTED]`;
    }
  }
  return '[REDACTED CREDENTIAL PATH]';
}

function redactCredentialPath(value: string): string {
  if (safeShapeCredPathEnabled()) {
    return value.replace(CREDENTIAL_PATH, (matched) => safeShapeCredentialPath(matched));
  }
  return value.replace(CREDENTIAL_PATH, '[REDACTED CREDENTIAL PATH]');
}

function redactText(value: string): string {
  return redactPhoneLike(redactCredentialPath(value
    .replace(PEM_PRIVATE_KEY, '[REDACTED PEM PRIVATE KEY]'))
    .replace(jidPattern(), '[REDACTED WHATSAPP JID]')
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .replace(AWS_ACCESS_KEY_ID, '[REDACTED AWS ACCESS KEY]')
    .replace(GITHUB_TOKEN, '[REDACTED GITHUB TOKEN]')
    .replace(JWT_VALUE, '[REDACTED JWT]')
    .replace(AUTHORIZATION_BEARER, 'Authorization: Bearer [REDACTED]')
    .replace(SECRETISH_ASSIGNMENT, (_match, key: string, sep: string, quote: string) => `${key}${sep}${quote}[REDACTED]`)
    .replace(BEARER_VALUE, 'Bearer [REDACTED]'));
}

// Intentionally distinct from transport/connection.ts's same-purpose redactor
// (and deliberately renamed away from its old shared name `redactDiagnosticValue`
// to remove the confusing collision). The split is safe: this outbox path only
// ever receives the type-locked `BotErrorsCriticalAssetDiagnostic` (fixed benign
// keys — `fingerprint` is a SHA-256 hash, `path` is covered by redactText's
// credential-path rule) plus pre-stringified strings. No sensitive-keyed object,
// raw Error instance, or deeply-nested attacker-shaped value can reach here, so
// connection.ts's key-sensitivity, depth-cap, and Error-instance handling are
// unreachable. `redactText` (secret-shape-based) is sufficient and complete for
// this input — same redaction output, no behavior change.
function redactOutboxValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactOutboxValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, redactOutboxValue(item)]),
    );
  }
  return value;
}

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'unknown';
}

function nowIso(): string {
  return new Date().toISOString();
}

function runningUnderVitest(): boolean {
  return process.env['VITEST'] === 'true'
    || process.env['VITEST_POOL_ID'] !== undefined
    || process.env['VITEST_WORKER_ID'] !== undefined;
}

function vitestStateDir(): string | null {
  if (process.env['BOT_ERRORS_ALLOW_LIVE_IN_TESTS'] === '1' || !runningUnderVitest()) {
    return null;
  }

  const workerId = safeSegment(process.env['VITEST_POOL_ID'] ?? process.env['VITEST_WORKER_ID'] ?? 'main');
  return join(tmpdir(), 'whatsoup-vitest-bot-errors', workerId, String(process.pid), 'state');
}

function stateDir(): string {
  return process.env['BOT_ERRORS_STATE_DIR'] ?? vitestStateDir() ?? join(homedir(), '.local', 'state', 'bot-errors');
}

function writefailDirs(): string[] {
  const candidates = [
    process.env['BOT_ERRORS_WRITEFAIL_DIR'],
    join(stateDir(), 'writefail'),
    join(homedir(), '.bot-errors-writefail'),
    join(process.env['TMPDIR'] ?? '/tmp', 'bot-errors-writefail'),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
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

function writeFileDurable(path: string, payload: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function recordBotErrorsWritefail(
  event: Record<string, unknown>,
  err: unknown,
  target: string,
): string | null {
  const reason = redactText(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  const eventId = typeof event.id === 'string' ? event.id : 'unknown';
  const instance = typeof event.instance === 'string' ? event.instance : 'unknown';
  const stamp = nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const fileName = `${stamp}.${safeSegment(instance)}.${safeSegment(eventId)}.writefail`;
  const breadcrumb = {
    schemaVersion: 1,
    kind: 'outbox_write_failure',
    recordedAt: nowIso(),
    failedTarget: redactText(target),
    reason,
    emitPid: process.pid,
    event: redactOutboxValue(event),
  };
  const payload = `${JSON.stringify(breadcrumb, null, 2)}\n`;

  for (const base of writefailDirs()) {
    const finalPath = join(base, fileName);
    const tmpPath = join(base, `.${fileName}.${process.pid}.tmp`);
    try {
      forceEnsurePrivateDirectorySync(base, 'bot-errors private directory');
      writeFileDurable(tmpPath, payload);
      renameSync(tmpPath, finalPath);
      chmodSync(finalPath, 0o600);
      fsyncDirectory(base);
      return finalPath;
    } catch {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Try the next fallback directory.
      }
    }
  }

  return null;
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
  const criticalAsset = input.criticalAsset
    ? redactOutboxValue(input.criticalAsset) as BotErrorsCriticalAssetDiagnostic
    : null;

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
    ...(criticalAsset ? { criticalAsset } : {}),
  };
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
    forceEnsurePrivateDirectorySync(outbox, 'bot-errors private directory');
    writeFileDurable(tmpPath, payload);
    renameSync(tmpPath, finalPath);
    chmodSync(finalPath, 0o600);
    fsyncDirectory(dirname(finalPath));
  } catch (err) {
    recordBotErrorsWritefail(event, err, finalPath);
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; the caller handles the write failure.
    }
    throw err;
  }

  return { eventId: event.id, path: finalPath };
}
