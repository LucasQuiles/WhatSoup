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
import { confineAlertContent } from './alert-evidence.ts';
import { jidPattern } from './redaction-patterns.ts';
import { asNonEmptyString } from './type-guards.ts';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type BotErrorsSeverity = 'critical' | 'error' | 'warning' | 'info';
export type BotErrorsEventType = 'alert' | 'clear' | 'observation';
export type BotErrorsEventKind = 'incident_alert' | 'incident_recovery' | 'observation';
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

interface BotErrorsEnvelopeFields {
  schemaVersion: 2;
  eventKind: BotErrorsEventKind;
  eventType: BotErrorsEventType;
  severity: BotErrorsSeverity;
}

// Mirror of the Python SSOT `KEYED_SECRET_RE` (deploy/scripts/lib/bot_errors_redaction.py):
// the compound keyed-secret set. The previous `\b(api_key|token|secret|...)\b`
// form could not match `client_secret`/`access_token`/`refresh_token`/`auth_token`
// (or any `_token`/`_secret` compound) because `_` is a word char, so no `\b`
// exists between `_` and the bare `token`/`secret` alternative — those compound
// keys leaked (BEAD-052). The `(^|[^A-Za-z0-9_]|\\n)` prefix group + per-key
// alternation mirrors the SSOT exactly. `credential` is RETAINED here even though
// the SSOT omits it: TS is the safer side (see the `div-credential-eq` corpus
// row + rationale).
//
// Two adversarial-review fixes are folded in (and mirrored in the Python SSOT):
//   * C1 (ReDoS): the `api[_-]?key` alternative bounds its optional prefix/suffix
//     wildcards to `[A-Za-z0-9_.-]{0,20}` instead of unbounded `*`. The prefix
//     group already anchors the key start; the `*` form backtracked quadratically
//     on dotted input (e.g. `1.1.1.…`). The bound still catches `x-api-key`,
//     `apikey`, and `x_api_key` while keeping the scan linear.
//   * C3 (`token=Bearer <secret>` leak): the VALUE capture optionally consumes a
//     leading `Bearer `/`Basic ` scheme so the whole token is masked (the bare
//     `[^\s…]+` value stopped at the space after `Bearer`, leaking the secret).
// BEAD-055 + QR-052: mirror of the Python SSOT `KEYED_SECRET_RE`. Two compound-key
// shapes anchor on a known-secret tail instead of leaking:
//   (a) multi-underscore compounds — `(?:[A-Za-z0-9]+_)*` consumes ANY number of
//       `<alnum>_` segments (BEAD-055 allowed only ONE → `AWS_SESSION_TOKEN=` /
//       `AWS_SECRET_ACCESS_KEY=` leaked). Each segment ends in a literal `_`, so the
//       split is deterministic: no catastrophic backtracking.
//   (b) camelCase-glued keys — `[A-Za-z0-9]{1,40}(?:token|secret|password|passphrase|
//       api[_-]?key)` catches `sessionToken=`/`bearerToken=`/`idToken=`; the `{1,40}`
//       bound caps prefix backtracking (ReDoS-safe).
// `secret[_-]?access[_-]?key` is an explicit entry for the AWS compound (secret word
// is mid-key, ends in `KEY`). Benign tails (`event_count`, `message_id`, `session_id`,
// `user_id`, `retry_count`) stay untouched — their tails are not secret-key words.
const SECRETISH_ASSIGNMENT =
  /(^|[^A-Za-z0-9_]|\\n)(["']?(?:[A-Za-z0-9]+_)*(?:(?:[A-Za-z0-9_.-]{0,20}api[_-]?key[A-Za-z0-9_.-]{0,20})|client[_-]?secret|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|cookie|credential|password|passphrase|secret|session|token|[A-Za-z0-9]{1,40}(?:token|secret|password|passphrase|api[_-]?key)|pat)["']?\s*[:=]\s*["']?)((?:(?:Bearer|Basic)\s+)?[^\s\\,"';}]+)(["']?)/gi;
// Mirror of the Python SSOT `AUTHORIZATION_BEARER_RE`: an `authorization` header
// carrying a `Bearer` OR `Basic` scheme. C2 fix — the prior form matched only
// `Authorization: Bearer …` (capital, colon-only, Bearer-only) and normalised the
// whole match to a literal, so `authorization: Basic <base64>` leaked verbatim.
// The captured prefix is preserved (`$1[REDACTED]`) so casing/scheme survive.
const AUTHORIZATION_BEARER = /\b(authorization\s*[:=]\s*(?:Bearer|Basic)\s+)[^\s\\"',;}]+/gi;
// Mirror of the Python SSOT `AUTHORIZATION_KEYED_RE`: a non-Bearer/non-Basic
// `authorization=<value>` / `authorization: <value>` assignment. Bearer/Basic
// values are deferred to AUTHORIZATION_BEARER (now Bearer AND Basic) + BEARER_VALUE
// via the negative lookahead, so this never double-redacts an already-masked
// authorization header.
const AUTHORIZATION_KEYED =
  /(^|[^A-Za-z0-9_]|\\n)(["']?authorization["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\s)([^\s\\,"';}]+)(["']?)/gi;
// Case-insensitive like the Python SSOT `BEARER_VALUE_RE` (fixes the lowercase
// `bearer <token>` leak), with the scheme captured so the original case is
// preserved on redaction. Intentionally OMITS Python's `{8,}` length floor: TS
// stays STRICTER (redacts short bearer tokens too, e.g. `Bearer abc.def`) — a
// safe divergence (over-redaction), never an under-redaction.
const BEARER_VALUE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
// JID redaction uses the canonical SSOT `jidPattern()` so the device-suffix
// (`:N`) dimension is never dropped — see `src/lib/redaction-patterns.ts`.
// Mirror of the Python SSOT `WHATSAPP_SERVICE_UNIT_RE`: a systemd/launchd unit
// name `whatsoup@<digits>.service` embeds the instance phone number, so mask the
// digit run while keeping the recognizable `whatsoup@…​.service` shape (I2).
const WHATSAPP_SERVICE_UNIT = /\b(whatsoup@)(\d{8,16})(\.service)?\b/gi;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
// BEAD-054: the prior `https?://`-only form UNDER-redacted non-http URL creds
// (`redis://`/`wss://`/`ldap://`/`ftp://` passed through verbatim). Match the
// Python SSOT `URL_USERINFO_RE` bounded any-scheme form: `[a-z][a-z0-9+.-]{0,30}://`.
// The `{0,30}` bound (not unbounded `*`) keeps the scan linear — importing the
// `*` form would import the Python ReDoS this bead removes.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
// Anchored, non-ambiguous prefix (lookbehind-guarded `~`/`/` + single lazy body)
// mirrors CREDENTIAL_PATH_RE in lib/bot_errors_redaction.py. The previous
// `(?:~|/[^\s]+)*` prefix allowed overlapping partitions of a long slash-path,
// which backtracked catastrophically (ReDoS) when the required suffix failed.
const CREDENTIAL_PATH =
  /(?:(?<![A-Za-z0-9._~-])~|(?<![A-Za-z0-9._~-])\/)[^\s"',;}]*?(?:\.config\/secrets\/[^\s"',;}]+|\.config\/whatsoup\/[^\s"',;}]+|\.local\/share\/whatsoup\/instances\/[^\s"',;}]*\/auth(?:\/[^\s"',;}]+)?|auth-bond-backups\/[^\s"',;}]+|\/(?:bot-errors\.env|fleet-token|fleet\.env|fleet-tokens\.json|tokens\.env|secrets\.env|\.env(?:\.[^\s"',;}]+)?))\b/gi;
// Separator `[\s_-]+` mirrors the Python SSOT (KEYED_PHONE_LIKE_RE /
// CONTEXT_PHONE_LIKE_RE): `_`/`-`-keyed phones (e.g. `msisdn_12025550181`,
// `phone_+1…`, `for_+1…`) must redact, not just whitespace-separated ones (L3-001).
const KEYED_PHONE_LIKE = /\b(phone|phone[_-]?number|msisdn|line)(\s*[:=]\s*|[\s_-]+)(\+?\d{10,16})\b/gi;
const CONTEXT_PHONE_LIKE = /\b(for)([\s_-]+)(\+?\d{10,16})\b/gi;
const PHONE_LIKE = /(^|[^\w])(\+?(?:\d[\d\s().-]{8,}\d))(?![\w])/g;

function redactPhoneLike(value: string): string {
  return value
    .replace(KEYED_PHONE_LIKE, (_match, key: string, sep: string) => `${key}${sep}[REDACTED PHONE]`)
    .replace(CONTEXT_PHONE_LIKE, (_match, key: string, sep: string) => `${key}${sep}[REDACTED PHONE]`)
    .replace(PHONE_LIKE, (match, prefix: string, candidate: string) => {
      const stripped = candidate.trim();
      // Mirror of the Python SSOT `redact_phone_like_match` guards: dotted version
      // strings (e.g. `2.3000.1020194169`) and ISO-ish dates/timestamps (e.g.
      // `2026-06-11 10:15:02`) are diagnostics, not phone numbers — never redact.
      //
      // I1 fix: the dotted-version guard must NOT exempt a phone written in dotted
      // form (e.g. `212.555.0181`, 10 digits in 3 short groups). A real version
      // carries a long build/segment number (>= 5 digits) or more than 15 total
      // digits; a dotted phone has 10–15 digits in short (<= 4 digit) groups. Only
      // exempt the candidate when it is a real version by that test.
      if (/^\d+(?:\.\d+){2,}(?:[-+~][A-Za-z0-9.-]+)?$/.test(stripped)) {
        const runs = stripped.match(/\d+/g) ?? [];
        const totalDigits = runs.reduce((sum, run) => sum + run.length, 0);
        const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
        if (totalDigits > 15 || longestRun >= 5) return match;
      }
      if (/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}(?::\d{2}(?::\d{2})?)?)?$/.test(stripped)) return match;
      const digits = candidate.replace(/\D/g, '');
      const hasPhoneSyntax = stripped.startsWith('+') || /[\s().-]/.test(candidate);
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
    .replace(WHATSAPP_SERVICE_UNIT, (_match, prefix: string, _digits: string, suffix?: string) => `${prefix}[REDACTED PHONE]${suffix ?? ''}`)
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .replace(AWS_ACCESS_KEY_ID, '[REDACTED AWS ACCESS KEY]')
    .replace(GITHUB_TOKEN, '[REDACTED GITHUB TOKEN]')
    .replace(JWT_VALUE, '[REDACTED JWT]')
    .replace(AUTHORIZATION_BEARER, '$1[REDACTED]')
    .replace(AUTHORIZATION_KEYED, (_match, pre: string, keySep: string, _value: string, closeQuote: string) => `${pre}${keySep}[REDACTED]${closeQuote}`)
    .replace(SECRETISH_ASSIGNMENT, (_match, pre: string, keySep: string, _value: string, closeQuote: string) => `${pre}${keySep}[REDACTED]${closeQuote}`)
    .replace(BEARER_VALUE, '$1[REDACTED]'));
}

// Stable export for parity testing (`tests/redaction-parity.test.ts`). The
// internal call sites keep using `redactText` unchanged.
export { redactText as redactBotErrorsText };

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

/**
 * Strong test-runner signals, mirroring `STRONG_TEST_SIGNAL_KEYS` in
 * `deploy/scripts/bot-errors-emit.py` and `deploy/hooks/post-tool-use-log.mjs`.
 *
 * `VITEST_POOL_ID` is present here but absent from the two sibling producers
 * because `runningUnderVitest()` above already treats it as a vitest signal for
 * *routing*. Omitting it would let a worker that sets only `VITEST_POOL_ID`
 * route into the isolated test state tree while still reporting `test: false` —
 * the exact split this stamp exists to prevent. The list is therefore a strict
 * superset, never a subset, of the shared four.
 */
const STRONG_TEST_SIGNAL_KEYS = [
  'VITEST',
  'VITEST_POOL_ID',
  'VITEST_WORKER_ID',
  'JEST_WORKER_ID',
  'PYTEST_CURRENT_TEST',
] as const;

function envValue(key: string): string | undefined {
  return asNonEmptyString(process.env[key]);
}

function strongTestSignals(): string[] {
  return STRONG_TEST_SIGNAL_KEYS.filter((key) => envValue(key) !== undefined);
}

function provenanceSignals(): string[] {
  const signals = strongTestSignals();
  if ((process.env['NODE_ENV'] ?? '').trim().toLowerCase() === 'test') signals.push('NODE_ENV');
  return [...new Set(signals)].sort();
}

/**
 * Which branch of `stateDir()` / `botErrorsOutboxDir()` actually decided this
 * process's queue. Values match the `policy` strings emitted by the Python and
 * hook producers so a dispatcher-side audit reads one vocabulary.
 *
 * There is no `test-redirect` here: that policy belongs to the sibling
 * producers, which re-point an already-live path when strong signals are
 * present. This module reaches the same end state earlier, via
 * `vitestStateDir()`, and its escape hatch is `BOT_ERRORS_ALLOW_LIVE_IN_TESTS`.
 */
function outboxPolicy(): 'explicit-outbox' | 'explicit-state' | 'test-default' | 'default' {
  if (process.env['BOT_ERRORS_OUTBOX_DIR'] !== undefined) return 'explicit-outbox';
  if (process.env['BOT_ERRORS_STATE_DIR'] !== undefined) return 'explicit-state';
  if (vitestStateDir() !== null) return 'test-default';
  return 'default';
}

/**
 * Producer provenance for the BOT ERRORS dispatcher's test-traffic backstop
 * (`is_test_provenance_event` in `deploy/scripts/bot-errors-dispatcher.py`,
 * which screens on `runtime.provenance.test === true`).
 *
 * Until this existed, TypeScript was the only one of the repo's event builders
 * that emitted no provenance, so TypeScript-shaped verifier and falsifier
 * traffic reached the dispatcher indistinguishable from a genuine incident.
 *
 * `resolvedOutbox` intentionally repeats `diagnostics.queue`: both sibling
 * producers carry it inside provenance, and a provenance record that cannot be
 * audited without cross-referencing a second branch of the event is worth less
 * than one duplicated path field.
 *
 * `BOT_ERRORS_ALLOW_LIVE_IN_TESTS` deliberately does NOT clear `test`. That
 * hatch governs routing — it sends a runner process's events to the live queue
 * instead of the sandbox — and attestation must not follow it: a runner process
 * writing to the live queue is exactly the combination the dispatcher backstop
 * exists to refuse. This does change behaviour for that hatch: such an event
 * previously reached delivery and now reaches suppressed audit state.
 *
 * Not covered: the legacy fallback in `emit-alert.ts`, which spawns a helper
 * with raw CLI arguments when the outbox write throws. It builds no event, so
 * it carries no provenance and cannot reach the dispatcher screen at all.
 */
export function botErrorsRuntimeProvenance(): {
  producer: string;
  test: boolean;
  signals: string[];
  strongSignals: string[];
  outboxPolicy: string;
  liveOutboxRedirected: boolean;
  resolvedOutbox: string;
} {
  const strongSignals = strongTestSignals();
  const policy = outboxPolicy();
  return {
    producer: 'typescript-outbox',
    test: strongSignals.length > 0,
    signals: provenanceSignals(),
    strongSignals,
    outboxPolicy: policy,
    // True exactly when the vitest state tree diverted this process off the
    // live home-based default. Derivable from `outboxPolicy` today; carried
    // explicitly because the sibling producers do, and a consumer should not
    // have to know each producer's policy vocabulary to answer "was this
    // steered away from the live queue?".
    liveOutboxRedirected: policy === 'test-default',
    resolvedOutbox: botErrorsOutboxDir(),
  };
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

// Issue #2386: relevantEnvKeys(), logHints(), shellSingleQuote(),
// logPredicateQuote(), hostPlatform(), and hostRelease() were removed.
// They produced runtime environment keys and operator log-hint commands
// that embedded instance names, paths, and host identifiers — exactly the
// metadata the evidence boundary now strips. The dispatcher can reconstruct
// operator hints from the bounded event fields (instance, source).

function newBotErrorsEnvelope(eventType: BotErrorsEventType, severity: BotErrorsSeverity): BotErrorsEnvelopeFields {
  if (eventType === 'alert' && ['critical', 'error', 'warning'].includes(severity)) {
    return { schemaVersion: 2, eventKind: 'incident_alert', eventType: 'alert', severity };
  }
  // Preserve the public alert API's historical informational-notice spelling
  // without persisting its ambiguous v1-shaped pair.
  if (eventType === 'alert' && severity === 'info') {
    return { schemaVersion: 2, eventKind: 'observation', eventType: 'observation', severity: 'info' };
  }
  if (eventType === 'clear' && severity === 'info') {
    return { schemaVersion: 2, eventKind: 'incident_recovery', eventType: 'clear', severity: 'info' };
  }
  if (eventType === 'observation' && severity === 'info') {
    return { schemaVersion: 2, eventKind: 'observation', eventType: 'observation', severity: 'info' };
  }
  throw new Error('invalid bot errors envelope');
}

export function buildBotErrorsEvent(input: BotErrorsOutboxInput, eventId = randomUUID(), createdAt = nowIso()) {
  const instance = input.instance.trim() || 'unknown';
  const source = input.source.trim() || 'unknown';
  const severity = input.severity ?? (input.eventType === 'alert' ? 'critical' : 'info');
  const envelope = newBotErrorsEnvelope(input.eventType, severity);
  const rawSummary = input.summary.trim() || `${envelope.eventType} event from ${source}`;
  const rawEvidence = input.evidence?.trim() ?? '';
  const criticalAsset = input.criticalAsset
    ? redactOutboxValue(input.criticalAsset) as BotErrorsCriticalAssetDiagnostic
    : null;

  // Issue #2386: confine evidence and summary to bounded metadata-only
  // fields at the emission boundary. Raw prose, exception text, provider
  // output, identifiers, and paths are replaced with failure-class hints,
  // length, and a non-reversible correlation digest.
  const confinedSummary = confineAlertContent('summary', rawSummary);
  const confinedEvidence = confineAlertContent('evidence', rawEvidence);

  return {
    ...envelope,
    id: eventId,
    createdAt,
    instance,
    source,
    summary: confinedSummary,
    evidence: confinedEvidence,
    // Issue #2386: strip absolute paths and raw process arguments. Keep
    // only bounded process metadata: pid, ppid, and node version.
    process: {
      pid: process.pid,
      ppid: process.ppid,
      argvCount: process.argv.length,
      node: process.version,
    },
    runtime: {
      invocationId: process.env['INVOCATION_ID'] ?? null,
      systemdExecPid: process.env['SYSTEMD_EXEC_PID'] ?? null,
      provenance: botErrorsRuntimeProvenance(),
    },
    diagnostics: {
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
  // Fail closed: when the outbox dir is NOT explicitly set and we're under
  // vitest, the resolved path MUST be under tmpdir — never the repo root
  // or homedir. Prevents the recurring src/main.ts sha256 drift caused by
  // a sandbox fallback writing into the working tree (#2658, #2887 CI).
  if (process.env['BOT_ERRORS_OUTBOX_DIR'] === undefined
      && process.env['BOT_ERRORS_STATE_DIR'] === undefined
      && process.env['BOT_ERRORS_TEST_ISOLATED'] === '1'
      && runningUnderVitest()) {
    const resolved = join(outbox, 'guard');
    if (!resolved.startsWith(tmpdir())) {
      throw new Error(
        `writeBotErrorsEvent under vitest would write outside tmpdir: ${outbox}`,
      );
    }
  }
  const event = buildBotErrorsEvent(input);
  // Preserve milliseconds while sorting *after* old same-second names, which
  // ended at `...SSZ.<instance>`. `_` sorts after that separator and keeps
  // new fractional timestamps lexical within their second.
  const fractionalTimestamp = event.createdAt.match(/^(.*)\.(\d{3})Z$/);
  const created = fractionalTimestamp
    ? `${fractionalTimestamp[1]!.replace(/[-:]/g, '')}Z_${fractionalTimestamp[2]}`
    : event.createdAt.replace(/[-:]/g, '');
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
