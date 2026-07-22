// Outbound client-safety guardrail — pure, transport-free decision primitives.
//
// A degraded/fallback agent model once sent a client chat (1) internal host
// paths and config/hook filenames and (2) a false "all tools are blocked"
// self-diagnosis. The orphan-hook root cause is fixed elsewhere; this module
// guards the *leak channel*: agent free-text flowing verbatim to a client.
//
// Scope is deliberately narrow and high-precision (no general "hallucination"
// detection). Two concerns:
//   A. redactInternalArtifacts — never emit operator-local paths / internal
//      runtime identifiers to client text.
//   B. classifyInfraStatusClaim — detect a false self-infra-failure claim so a
//      caller can divert it to ops instead of the client.
//
// This file performs NO sending and NO other I/O, and stays pure otherwise.
// Callers (the MCP send_message path) decide what to do with a decision. The
// ONE exception (T8-F1, WG-7): `isOperatorDmPeer` logs a single component-
// tagged, id-only warn when a lid-form peer does not resolve to an admin
// phone, so an audience-elevation decision is never silent (see the function
// doc). Nothing else in this file logs.
//
// SSOT note: the secret/token masking is reused from
// `sanitizeProviderPreviewText` (email masking stays enabled there for
// background surfaces but is switched OFF for chat egress — B25 chat-scope
// owner ruling; see redactInternalArtifacts). The ops-evidence path keeps the
// sanitizer's full default, emails included — it feeds BOT ERRORS diagnostics,
// a background surface. The internal-path / identifier / PII shapes
// here overlap with `scripts/repo-hygiene-guard.ts` and the BOT ERRORS outbox
// redactor; if a third consumer appears, extract a shared
// `src/lib/internal-artifact-patterns.ts` (deferred per YAGNI — one consumer now).

import { sanitizeProviderPreviewText } from '../lib/provider-preview-sanitizer.ts';
import { jidPattern } from '../lib/redaction-patterns.ts';
import { isAdminPhone } from '../lib/phone.ts';
import { isLidJid, isAuthenticatedSenderForTransport } from './jid-constants.ts';
import { resolvePhoneFromJid } from './access-list.ts';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';

const audienceLog = createChildLogger('outbound-audience');

// ---------------------------------------------------------------------------
// B21-C: spoof-attempt warn dedupe.
//
// isOperatorDmPeer is evaluated on EVERY outbound send (messaging.ts,
// media.ts, runtime call sites), so a legitimate operator SMS-interop DM
// (peer = admin digits @sms) would emit one 'spoof attempt denied' warn per
// bot reply — a sustained log flood mislabeled as an attack. The WARN is
// deduped per chatJid on a TTL (pattern mirrors emit-alert's throttle map);
// the deny DECISION is never deduped, and NFR-3 never-silent still holds:
// every distinct chatJid warns, only repeats within the TTL are suppressed.
// ---------------------------------------------------------------------------
const SPOOF_WARN_TTL_MS = 10 * 60 * 1000;

/** Maps chatJid → epoch ms of the last emitted spoof-attempt warn. */
const spoofWarnLastLoggedAt = new Map<string, number>();

/** Reset the spoof-attempt warn dedupe map (for tests). */
export function resetSpoofWarnDedupe(): void {
  spoofWarnLastLoggedAt.clear();
}

/** True when a spoof-attempt warn for `chatJid` should be emitted now. */
function shouldWarnSpoofAttempt(chatJid: string, now: number): boolean {
  const lastLoggedAt = spoofWarnLastLoggedAt.get(chatJid);
  if (lastLoggedAt !== undefined && now - lastLoggedAt < SPOOF_WARN_TTL_MS) {
    return false;
  }
  // Prune expired entries on insert so the map stays bounded to chatJids
  // seen within the last TTL window.
  for (const [jid, loggedAt] of spoofWarnLastLoggedAt) {
    if (now - loggedAt >= SPOOF_WARN_TTL_MS) spoofWarnLastLoggedAt.delete(jid);
  }
  spoofWarnLastLoggedAt.set(chatJid, now);
  return true;
}

/**
 * True iff `chatJid` is a 1:1 DM whose peer is a config admin (T8-F1).
 *
 * Keys on the CHATJID (the conversation peer), NOT a sender JID — an OUTBOUND
 * message has no meaningful sender (the bot is sending), so the operator
 * identity is the chat itself. Resolves `@lid` → phone via
 * `resolvePhoneFromJid` (which consults `lid_mappings`): the owner-DM
 * outbound `chatJid` on the deployed q instance is OBSERVED-LIVE to be the
 * lid form (V32), so lid resolution is the PRIMARY case here, not
 * defense-in-depth.
 *
 * NEVER silent: when a lid-form peer does not resolve to an admin phone
 * (unmapped lid → `resolvePhoneFromJid` falls back to the raw LID digits,
 * which will not match `adminPhones`), a single warn is logged — component-
 * tagged and id-only (N14: never the chatJid/lid value) — so a lid-thread
 * audience decision is always observable, never a silent client fall-through.
 *
 * Same convention applies to the QR-143 @sms guard's spoof-attempt SUBSET
 * (fast-follow): an unauthenticated peer that BEARS ADMIN DIGITS — i.e.
 * would resolve to an admin phone were the transport trusted — is a spoof
 * attempt, not ordinary traffic, so it warns per NFR-3 ("gate denials log
 * unsampled, always"). Every OTHER @sms rejection (a benign SMS-bridge chat
 * with no admin-shaped digits) stays silent — warning on every one would be
 * noise, not signal. B21-C: because this predicate runs on every outbound
 * send, the spoof warn itself is deduped per chatJid on a TTL (see
 * `shouldWarnSpoofAttempt`) — never-silent per chat, not per send; the deny
 * return value is never deduped.
 */
export function isOperatorDmPeer(
  chatJid: string,
  isGroup: boolean,
  db: Database,
  adminPhones: Set<string>,
  transport: string | null | undefined = 'baileys',
): boolean {
  if (isGroup) return false;
  // Shared by BOTH (mutually exclusive) branches below: does the peer resolve
  // to a configured admin phone? On the unauthenticated branch it selects the
  // spoof-attempt warn subset; on the authenticated branch it IS the
  // elevation decision.
  //
  // B4 (QR-143): this inline `isAdminPhone(resolvePhoneFromJid(...))` is
  // DELIBERATELY NOT migrated to `resolvePhoneFromJidForGrant`, and is
  // allowlisted in `scripts/grant-resolver-inventory-guard.ts`. The GRANT
  // decision here is already gated on
  // `isAuthenticatedSenderForTransport(chatJid, transport)`
  // (line ~119) before the elevation `return peerBearsAdminDigits`. The phone
  // match is ALSO needed on the UNauthenticated branch to select the
  // spoof-attempt warn subset (an @sms peer bearing admin digits is a spoof
  // attempt, not noise) — routing through the grant primitive would null the
  // phone on @sms and silence that never-silent warn (NFR-3). So the composed
  // semantics are NOT byte-equivalent to the primitive; migrating here would
  // regress observability.
  const peerBearsAdminIdentity = isAdminPhone(resolvePhoneFromJid(chatJid, db), adminPhones);
  // QR-143: operator identity must come from the namespace bound to the
  // configured transport. @sms is spoofable, and a WhatsApp/Signal/iMessage
  // identity from another namespace must not cross-elevate. Without this guard,
  // a spoofed `<admin-digits>@sms` or mismatched transport JID could elevate.
  if (!isAuthenticatedSenderForTransport(chatJid, transport)) {
    // This is a DENY-side observability check only. Inspect the untrusted local
    // part directly so a numeric `<admin>@c.us` or `<admin>@sms` still raises a
    // spoof warning, without weakening the exact-identity grant check above for
    // UUIDs and other non-phone transport identities.
    const atIdx = chatJid.indexOf('@');
    const localPart = atIdx === -1 ? chatJid : chatJid.slice(0, atIdx);
    const peerBearsAdminDigits = isAdminPhone(localPart, adminPhones);
    // Fast-follow: warn ONLY on the spoof-attempt subset (bears admin digits).
    // Do NOT warn on every @sms rejection — that fires on every benign
    // SMS-bridge chat and would be noise, not a never-silent signal.
    if (peerBearsAdminDigits && shouldWarnSpoofAttempt(chatJid, Date.now())) {
      // This branch catches every form not authenticated for the configured
      // transport (@sms, @c.us, a cross-transport namespace, …), so log the
      // ACTUAL form — the '@' suffix —
      // not a hardcoded 'sms' label. Still id-only (N14): the suffix is the
      // transport domain, never the peer digits.
      const chatJidForm = atIdx === -1 ? 'unknown' : chatJid.slice(atIdx + 1) || 'unknown';
      audienceLog.warn(
        { chatJidForm, outcome: 'spoof-attempt-denied' },
        'operator-DM unauthenticated peer bore admin-like digits and does not match the configured transport — spoof attempt denied',
      );
    }
    return false;
  }
  if (!peerBearsAdminIdentity && isLidJid(chatJid)) {
    audienceLog.warn(
      { chatJidForm: 'lid', outcome: 'not-elevated' },
      'operator-DM lid peer did not resolve to an admin phone — not elevated',
    );
  }
  return peerBearsAdminIdentity;
}

export type OutboundAudience = 'client' | 'ops' | 'internal';

export type OutboundMessageSafetyAction = 'allow' | 'redact' | 'divert' | 'suppress';

export type AssistantTextSuppressionReason =
  | 'ack_filler'
  | 'internal_narration'
  | 'progress_filler'
  | 'send_verification'
  | 'noop';

export type AssistantTextEgressDecision =
  | { action: 'allow' }
  | {
      action: 'suppress';
      reason: AssistantTextSuppressionReason;
      satisfiesReplyGuarantee: boolean;
    };

export type RedactionCategory =
  | 'home_path'
  | 'internal_path'
  | 'internal_identifier'
  | 'tailnet_ip'
  | 'sensitive_path'
  | 'provider_secret';

export interface Redaction {
  category: RedactionCategory;
  /** A short, non-sensitive label of what was masked (never the raw value). */
  label: string;
}

export interface OutboundMessageSafetyInput {
  text: string;
  audience: OutboundAudience;
}

export interface OutboundMessageSafetyDecision {
  action: OutboundMessageSafetyAction;
  text: string;
  reason?: 'internal_artifact' | 'false_infra_block_claim' | AssistantTextSuppressionReason;
  redactions?: Redaction[];
  /** Sanitized diagnostic for ops/BOT ERRORS — PII/secret/username-free. */
  opsEvidence?: string;
}

/** Generic, non-technical text shown to a client when the original is diverted. */
export const CLIENT_TEMPORARY_ISSUE_TEXT =
  'I hit a temporary issue and am retrying. I will follow up shortly.';

const NOOP_ASSISTANT_TEXT = /^(?:[.!?…]+|[-_]+)$/u;
const SEND_VERIFICATION_PATTERNS: readonly RegExp[] = [
  /^send-and-verify\b.{0,120}\b(?:ok|complete|done|verified|pk\s+\d+|delivered|sent)\b/i,
  /\bread-?back\b.{0,160}\b(?:verified|pk\s+\d+|correct chat|matching content|delivered)\b/i,
  /\b(?:verified|delivery verified|delivered \(verified\))\b[^.]{0,120}\bpk\s+\d+\b/i,
  /\bpk\s+\d+\b[^.]{0,120}\b(?:verified|correct chat|matching content|delivered)\b/i,
  /\blanded cleanly\b.{0,160}\b(?:pk\s+\d+|delivered|sent|verified|message)\b/i,
  /\b(?:message|send|delivery|read-?back)\b.{0,120}\blanded cleanly\b/i,
  /^acknowledged and delivered\b.{0,120}\b(?:verified|pk\s+\d+)\b/i,
  /^intended .{0,80}\bverified\b/i,
  // #1751: this ack-shaped text asserts a delivery actually happened
  // ("confirmed delivery", "landed clean") — the same delivery claim as the
  // patterns above, so it belongs under send_verification (evidence-gated)
  // rather than ACK_FILLER_PATTERNS (evidence-free, deliberate-silence
  // contract). Moved out of ACK_FILLER_PATTERNS, not duplicated — send_
  // verification is classified first, so matching text now takes this reason.
  /^acknowledged\b.{0,140}\b(?:confirmed delivery|landed clean)\b.{0,260}\b(?:lane stays parked|nothing further to do)\b/i,
];

const ACK_FILLER_PATTERNS: readonly RegExp[] = [
  /^parked per\b.{0,80}\bdirective\b.{0,260}\b(?:no new evidence|no user ask|not reposting|holding until auth)\b/i,
  /^understood\b.{0,100}\b(?:deploy\b.{0,40}\bnoted|noted)\b.{0,260}\b(?:lane parked|won(?:'|’)t repost|pick\b.{0,80}\bback up)\b/i,
  /^understood\b.{0,80}\bholding\b.{0,260}\b(?:lcp\s+)?lane parked\b.{0,260}\bno further status pings\b/i,
  /^acknowledged internally\b.{0,100}\bno action taken\b.{0,260}\b(?:directive is explicit|auth changes|user asks|lane (?:stays )?parked)\b/i,
  /^\(?no action(?: (?:taken|needed|required))?\)?[.!]?$/i,
  /^\(?no action\b.{0,260}\b(?:status noted internally|nothing to send|no user ask pending|standing by|(?:lcp|lane) stays parked)\b/i,
  /^(?:holding\b.{0,120}\b)?no (?:response|reply) (?:needed|required|warranted)\b(?:[.!]?$|.{0,180}\b(?:control note|directive|status ping|user ask|reply)\b)/i,
  /^no outbound warranted\b.{0,260}\b(?:do not reply|do not ack|status-?ping|no user ask|staying silent|sending nothing)\b/i,
  /^i(?:\s+will|(?:'|’)?ll)\s+stay silent\b.{0,300}\b(?:directive is explicit|do not acknowledge|no action until|no user request pending|no message will be sent)\b/i,
  /^no (?:action|acknowledg(?:e)?ment) (?:needed|required)\b.{0,160}\bstaying silent\b(?:[.!]?$|.{0,120}\b(?:directive|no message|no user request|auth changes|user asks)\b)/i,
  /^staying silent\b.{0,120}\b(?:per directive|do not acknowledge|no message will be sent|no user request)\b/i,
  /\blane (?:stays )?parked\b.{0,260}\b(?:nothing further to do|won(?:'|’)t repost|not reposting|holding until auth)\b/i,
];

const INTERNAL_NARRATION_OPENERS: readonly RegExp[] = [
  /^now\b.{0,160}\b(?:add|wire|rebuild|update|run|send|read|check|pull|load|implement|smoke|verify|workbook|sheet|script|command|tool|delete|revoke|entryrows|weekemployeetotals)\b/i,
  /^let me\b(?!\s+know\b).{0,160}\b(?:implement|close|pull|send|verify|revoke|delete|wire|load|check|read|run)\b/i,
  /^i(?:'|’)?ll\s+(?:silently\s+)?(?:check|record|confirm|inspect|look|verify)\b.{0,180}\b(?:gate|state|surface|surfacing|tool|thread|message|target|preflight)\b/i,
  /^(?:loading|reading|checking|pulling|verifying)\b.{0,160}\b(?:tool|file|log|db|database|message|thread|script|command|workbook|sheet|pk|read-?back|socket)\b/i,
  /^root cause confirmed\b/i,
  /^one more narration line leaked\b/i,
  /^the \d+ leaked narration lines\b/i,
  /\blet me\b.{0,80}\b(?:record|confirm)\b.{0,120}\bbefore surfacing\b/i,
  /\blet me\b.{0,100}\bsend\b.{0,120}\b(?:gate|status|chat|message)\b/i,
  /\b(?:outside a tool call|loading the delete tool|smoke\/verify script)\b/i,
];

const INTERNAL_WORK_HEADING =
  /^(?:add|wire|rebuild|update)\b.{0,120}\b(?:command|script|sheet|workbook|summary|rows?|columns?|anomal(?:y|ies))\b/i;

const PROGRESS_FILLER_PATTERNS: readonly RegExp[] = [
  /^_?still working(?:\s+\(\d+s\))?\.{3}_?$/i,
  /^i(?:'|’| a)m\s+still\s+working(?:\s+on\s+this)?(?:\s+and\s+(?:will\s+)?follow\s+up\s+shortly)?[.!]?$/i,
];

/**
 * Classify raw provider assistant_text before it becomes a WhatsApp message.
 *
 * This is deliberately narrow: it catches process narration and send
 * verification chatter observed in the agent transport, not arbitrary
 * low-quality replies. The MCP text-send guard also reuses this classifier for
 * explicit tool payloads so send_message/reply/edit cannot bypass the same
 * known no-op/narration patterns.
 */
export function classifyAssistantTextEgress(text: string): AssistantTextEgressDecision {
  const trimmed = text.trim();
  if (!trimmed) return { action: 'allow' };

  if (NOOP_ASSISTANT_TEXT.test(trimmed)) {
    return { action: 'suppress', reason: 'noop', satisfiesReplyGuarantee: true };
  }

  if (SEND_VERIFICATION_PATTERNS.some((re) => re.test(trimmed))) {
    return { action: 'suppress', reason: 'send_verification', satisfiesReplyGuarantee: true };
  }

  if (ACK_FILLER_PATTERNS.some((re) => re.test(trimmed))) {
    return { action: 'suppress', reason: 'ack_filler', satisfiesReplyGuarantee: true };
  }

  if (
    INTERNAL_NARRATION_OPENERS.some((re) => re.test(trimmed)) ||
    INTERNAL_WORK_HEADING.test(trimmed)
  ) {
    return { action: 'suppress', reason: 'internal_narration', satisfiesReplyGuarantee: false };
  }

  if (PROGRESS_FILLER_PATTERNS.some((re) => re.test(trimmed))) {
    return { action: 'suppress', reason: 'progress_filler', satisfiesReplyGuarantee: false };
  }

  return { action: 'allow' };
}

/**
 * Resolve the audience for an outbound agent send by its target chat:
 *   - `ops`      — the configured BOT ERRORS channel (`BOT_ERRORS_JID`);
 *                  verbatim diagnostics preserved.
 *   - `internal` — an operator-owned agent-coordination group listed in
 *                  `WHATSOUP_INTERNAL_JIDS`, OR (T8-F1+F2) an admin's 1:1 DM
 *                  on the trusted primary (see `ctx` below); the fleet's own
 *                  vocabulary (home/`~` paths, `.claude/`, hook-event names,
 *                  bead `Files:` lists) is legitimate content there, so it is
 *                  NOT scrubbed as a leak.
 *   - `client`   — everything else; the conservative default, since a false
 *                  redaction on an operator message is low-harm while a leak to
 *                  a real client is high-harm.
 * Shared by every agent free-text send tool (send/reply/edit/poll/media) so none
 * is a bypass.
 *
 * Reads `process.env.BOT_ERRORS_JID` and `process.env.WHATSOUP_INTERNAL_JIDS` —
 * the only env dependencies in this otherwise pure module; kept here so
 * audience policy has a single home.
 *
 * `ctx` (T8-F1+F2, OPTIONAL — omitting it preserves the exact pre-F1+F2
 * behavior for every existing caller):
 *   - `isGroup`       — the target is a group chat (never elevated).
 *   - `peerIsAdmin`   — `isOperatorDmPeer(chatJid, isGroup, db, adminPhones)`,
 *                       computed by the caller (this function stays boolean-in,
 *                       no DB access here — SoC).
 *   - `fallbackActive`— true while a FALLBACK (non-trusted-primary) provider
 *                       window is active. FAIL-CLOSED: a caller that cannot
 *                       determine this MUST pass `true` (full scrub), never
 *                       default `false` — `false` here elevates an operator DM
 *                       to `internal`, and an unknown-state elevation during a
 *                       degraded/fallback model is the exact leak this guards.
 * Elevation requires ALL THREE: `!isGroup && peerIsAdmin && !fallbackActive`.
 * `ops`/env-`internal` are checked first and still win (ctx never downgrades
 * an already-internal/ops chat).
 */
const EMPTY_JID_SET: ReadonlySet<string> = new Set();

/**
 * Parse the `WHATSOUP_INTERNAL_JIDS` allow-list (comma-separated). Read per-call
 * (cheap) so an env change takes effect on the next send without a restart.
 */
function internalGroupJids(): ReadonlySet<string> {
  const raw = process.env['WHATSOUP_INTERNAL_JIDS']?.trim();
  if (!raw) return EMPTY_JID_SET;
  return new Set(raw.split(',').map((j) => j.trim()).filter(Boolean));
}

export function resolveOutboundAudience(
  chatJid: string,
  ctx?: { isGroup: boolean; peerIsAdmin: boolean; fallbackActive: boolean },
): OutboundAudience {
  const opsJid = process.env['BOT_ERRORS_JID']?.trim();
  if (opsJid && chatJid === opsJid) return 'ops';
  if (internalGroupJids().has(chatJid)) return 'internal';
  // T8-F1+F2: an admin's 1:1 DM on the trusted primary (no fallback window) is
  // an operator channel. This SUPERSEDES the WHATSOUP_INTERNAL_JIDS owner-DM
  // stopgap entry (which stays group-oriented going forward) — an env-absent
  // owner DM still resolves `internal` via this branch.
  if (ctx && !ctx.isGroup && ctx.peerIsAdmin && !ctx.fallbackActive) return 'internal';
  return 'client';
}

// --- Internal-artifact shapes (linear / ReDoS-safe; no nested quantifiers) ---

// Absolute home directory paths and everything that hangs off them. The user
// segment is intentionally generic; the repo-hygiene allow-list does not apply
// here because the guardrail must mask every operator path at runtime.
const HOME_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g;
// The home-prefix alone, for ops evidence (mask the username, keep structure).
const HOME_PATH_USER = /(\/(?:Users|home)\/)[A-Za-z0-9._-]+/g;
// Tilde-rooted home paths (`~/...`) — NOT covered by HOME_PATH. Requires `~/`
// followed by at least one path segment so a bare `~` or `~5` is left alone.
const TILDE_PATH = /~(?:\/[A-Za-z0-9._-]+)+/g;
// The WhatSoup internal config/state/credential tree when it appears without a
// home prefix (e.g. a bare `.config/whatsoup/instances/<x>/auth`). Mirrors the
// path shapes the BOT ERRORS outbox redacts (`src/lib/bot-errors-outbox.ts`
// CREDENTIAL_PATH); if a third consumer appears, extract a shared module.
const WHATSOUP_TREE =
  /(?:\.config\/whatsoup|\.local\/share\/whatsoup|auth-bond-backups)(?:\/[A-Za-z0-9._-]+)*/g;
// Standalone runtime identifiers that should never reach a client verbatim.
const INTERNAL_IDENTIFIERS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /agent-sandbox\.sh/g, label: 'sandbox-hook' },
  { re: /sandbox-policy\.json/g, label: 'sandbox-policy' },
  { re: /\.claude\//g, label: 'claude-dir' },
  { re: /settings\.json/g, label: 'settings-file' },
  { re: /PreToolUse|PostToolUse/g, label: 'hook-event' },
];
// Tailnet / CGNAT shared address space (100.64.0.0/10).
const TAILNET_IP =
  /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g;
const SENSITIVE_PATH_TOKEN = /(?<![A-Za-z0-9.-])(?:~\/|\/)[^\s"',;}\])>]+/g;
const CREDENTIAL_FILE_NAMES = new Set([
  'bot-errors.env',
  'fleet-token',
  'fleet.env',
  'fleet-tokens.json',
  'tokens.env',
  'secrets.env',
]);
const TRAILING_PATH_PUNCTUATION: ReadonlySet<string> = new Set(['.', ':', '`', '!', '?', '*', '_', '~']);
const TRAILING_PATH_UNICODE_PUNCTUATION = /[\p{P}\p{Cf}]/u;
// PII shapes for ops-evidence sanitization (mirror BOT ERRORS outbox posture).
// JID redaction uses the canonical SSOT `jidPattern()` so the device-suffix
// (`:N`) dimension is never dropped — see `src/lib/redaction-patterns.ts`.
const PHONE_LIKE = /(^|[^\w])(\+?\d[\d\s().-]{8,}\d)(?![\w])/g;

function maskPhoneLike(value: string): string {
  return value.replace(PHONE_LIKE, (match, prefix: string, candidate: string) => {
    const digits = candidate.replace(/\D/g, '');
    const hasPhoneSyntax = candidate.trim().startsWith('+') || /[\s().-]/.test(candidate);
    return hasPhoneSyntax && digits.length >= 10 && digits.length <= 15
      ? `${prefix}[redacted-phone]`
      : match;
  });
}

function hasPathSegmentAfter(path: string, segment: string, start: number): boolean {
  let index = path.indexOf(`/${segment}`, start);
  while (index !== -1) {
    const end = index + segment.length + 1;
    if (end === path.length || path[end] === '/') return true;
    index = path.indexOf(`/${segment}`, end);
  }
  return false;
}

function sensitivePathLabel(path: string): string | null {
  const normalized = path.toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const configRoot = normalized.indexOf('/.config/whatsoup/');
  const stateRoot = normalized.indexOf('/.local/share/whatsoup/instances/');

  if (
    normalized.includes('/.config/secrets/')
    || normalized.includes('/auth-bond-backups/')
    || (configRoot !== -1 && hasPathSegmentAfter(normalized, 'auth', configRoot))
    || (stateRoot !== -1 && hasPathSegmentAfter(normalized, 'auth', stateRoot))
    || CREDENTIAL_FILE_NAMES.has(basename)
    || basename === '.env'
    || basename.startsWith('.env.')
  ) {
    return 'credential-path';
  }
  if (
    normalized.includes('/.ssh/')
    && (basename.startsWith('id_') || basename.endsWith('.pem') || basename.endsWith('.key'))
  ) {
    return 'ssh-key-path';
  }
  if (basename.endsWith('.pem') || basename.endsWith('.key')) return 'key-file-path';
  return null;
}

function redactSensitivePaths(text: string, redactions: Redaction[]): string {
  const labels = new Set<string>();
  const out = text.replace(SENSITIVE_PATH_TOKEN, (match) => {
    const queryIndex = match.search(/[?#]/);
    let end = queryIndex === -1 ? match.length : queryIndex;
    while (
      end > 1
      && (
        TRAILING_PATH_PUNCTUATION.has(match[end - 1]!)
        || (
          match[end - 1] !== '/'
          && TRAILING_PATH_UNICODE_PUNCTUATION.test(match[end - 1]!)
        )
      )
    ) {
      end -= 1;
    }
    const candidate = match.slice(0, end);
    const suffix = match.slice(end);
    const label = sensitivePathLabel(candidate);
    if (!label) return match;
    labels.add(label);
    return `[sensitive-path]${suffix}`;
  });
  for (const label of labels) redactions.push({ category: 'sensitive_path', label });
  return out;
}

/**
 * Mask internal artifacts in outbound text, scaled to `audience`:
 *   - `client`   — full scrub: secrets/tokens, then operator paths, runtime
 *                  identifiers, and tailnet IPs.
 *   - `internal` — secrets/tokens/sensitive credential paths only; operator
 *                  vocabulary is legitimate content in operator-owned agent
 *                  groups, so masking it there is over-redaction.
 *   - `ops`      — verbatim (BOT ERRORS needs raw diagnostics; its outbox
 *                  redactor scrubs secrets downstream).
 * Email addresses are NEVER masked here (any audience): B25 chat-scope owner
 * ruling — email redaction is background-only (provider previews, logs,
 * handoff summarizers) and must not mutate chat-visible text.
 * Defaults to `client`, so existing single-arg callers are unchanged.
 * Returns the cleaned text plus a categorised (non-sensitive) redaction list.
 */
export function redactInternalArtifacts(
  text: string,
  audience: OutboundAudience = 'client',
): { text: string; redactions: Redaction[] } {
  // Ops receives verbatim diagnostics — the BOT ERRORS outbox redactor scrubs
  // secrets downstream (defense in depth).
  if (audience === 'ops') return { text, redactions: [] };

  const redactions: Redaction[] = [];
  let out = text;

  // Secret/token masking applies to client AND internal: WhatsApp is a
  // third-party transport, so a leaked credential is exposure even in an
  // operator-owned group. EMAIL masking does NOT apply here — B25 chat-scope
  // owner ruling (2026-07-19): email redaction is a BACKGROUND-ONLY function
  // (provider previews, logs, handoff summarizers) and must never mutate
  // chat-visible message text (live defect: 121 outbound chat messages carried
  // the literal '[REDACTED_EMAIL]' marker). `redactEmailLike: false` skips the
  // whole email-class pass; the preserve* flags are kept so flipping the email
  // flag back for any single audience restores the exact prior behavior with
  // one edit (e.g. a future client-tier exception).
  const sanitized = sanitizeProviderPreviewText(out, {
    preserveWhatsAppJids: audience === 'internal',
    preserveWhatsAppMentions: true,
    redactEmailLike: false,
  });
  if (sanitized !== out) {
    redactions.push({ category: 'provider_secret', label: 'token-or-credential' });
    out = sanitized;
  }

  // Operator-artifact masking (home/tilde paths, the WhatSoup config tree,
  // runtime identifiers, tailnet IPs) is CLIENT-only. In internal agent groups
  // these strings are the coordination vocabulary itself.
  if (audience === 'internal') {
    out = redactSensitivePaths(out, redactions);
    return { text: out, redactions };
  }

  // Full paths first so a path + dotfile tail collapses to one marker before the
  // standalone-identifier pass can fire inside it. Order: absolute home paths,
  // then tilde-rooted, then the bare WhatSoup config/state tree.
  if (HOME_PATH.test(out)) {
    out = out.replace(HOME_PATH, '[internal-path]');
    redactions.push({ category: 'home_path', label: 'home-path' });
  }
  if (TILDE_PATH.test(out)) {
    out = out.replace(TILDE_PATH, '[internal-path]');
    redactions.push({ category: 'internal_path', label: 'tilde-path' });
  }
  if (WHATSOUP_TREE.test(out)) {
    out = out.replace(WHATSOUP_TREE, '[internal-path]');
    redactions.push({ category: 'internal_path', label: 'whatsoup-tree' });
  }

  for (const { re, label } of INTERNAL_IDENTIFIERS) {
    if (re.test(out)) {
      out = out.replace(re, '[internal]');
      redactions.push({ category: 'internal_identifier', label });
    }
  }

  if (TAILNET_IP.test(out)) {
    out = out.replace(TAILNET_IP, '[internal-address]');
    redactions.push({ category: 'tailnet_ip', label: 'tailnet-ip' });
  }

  return { text: out, redactions };
}

// --- False infra-status self-diagnosis (high precision; bounded clauses) ---

const INFRA_CLAIM_PATTERNS: readonly RegExp[] = [
  // SELF-referential only: a first-person claim that the agent's OWN tools are
  // blocked. Requiring "my"/"I" keeps the agent helping a client with the
  // CLIENT's tools ("your tools are blocked by the firewall") from being
  // diverted — a divert would replace genuine help with a generic stub.
  /\b(?:all\s+)?my\s+tools\s+(?:are|is)\s+(?:being\s+|currently\s+)?blocked\b/i,
  /\bI\s+(?:can(?:'|’)?t|cannot|am\s+unable\s+to)\s+(?:run|use|access|call)\s+(?:any\s+)?(?:of\s+)?(?:my\s+)?tools\b/i,
  // Internal runtime terms that are inherently the agent's own — a client has no
  // agent-sandbox or sandbox policy — so these stay unconditional.
  /\bfailing\s+closed\b/i,
  /\bagent[\s-]?sandbox\b[^.]*\b(?:failing|blocked|closed)\b/i,
  /\bsandbox[\s-]?policy(?:\s+file)?(?:\.json)?\b[^.]*\b(?:missing|not\s+found|gone)\b/i,
  /\bsandbox\b[^.]*\b(?:is\s+)?(?:missing|failing\s+closed)\b/i,
];

/** True when the text asserts a (false) failure of the agent's own tooling/sandbox. */
export function classifyInfraStatusClaim(text: string): boolean {
  return INFRA_CLAIM_PATTERNS.some((re) => re.test(text));
}

/**
 * Sanitize a diagnostic for ops/BOT ERRORS: preserve the operational meaning
 * (hook names, "failing closed") but strip secrets, emails, path usernames,
 * WhatsApp JIDs, and phone numbers. (Lane 2 also routes divert evidence through
 * the BOT ERRORS outbox, which redacts again — defense in depth.)
 */
function sanitizeOpsEvidence(text: string): string {
  let out = text.replace(jidPattern(), '[redacted-jid]');
  out = sanitizeProviderPreviewText(out);
  out = out.replace(HOME_PATH_USER, '$1[redacted-user]');
  out = maskPhoneLike(out);
  return out;
}

/**
 * Decide how a single outbound message should be handled for its audience.
 * Ops sends are never rewritten. Internal sends have secrets/tokens masked but
 * keep operator vocabulary. Client sends are diverted when they make a false
 * infra-failure claim, redacted when they leak an internal artifact, and
 * otherwise allowed unchanged. Emails are never masked on chat egress (B25
 * chat-scope owner ruling — see redactInternalArtifacts).
 */
export function evaluateOutboundMessageSafety(
  input: OutboundMessageSafetyInput,
): OutboundMessageSafetyDecision {
  const { text, audience } = input;

  // Ops receives verbatim diagnostics.
  if (audience === 'ops') {
    return { action: 'allow', text };
  }

  const assistantDecision = classifyAssistantTextEgress(text);
  if (assistantDecision.action === 'suppress') {
    return { action: 'suppress', text: '', reason: assistantDecision.reason };
  }

  // Only a client send can make a false self-infra-block claim worth diverting;
  // internal agents legitimately discuss their own tooling state.
  if (audience === 'client' && classifyInfraStatusClaim(text)) {
    return {
      action: 'divert',
      text: CLIENT_TEMPORARY_ISSUE_TEXT,
      reason: 'false_infra_block_claim',
      opsEvidence: sanitizeOpsEvidence(text),
    };
  }

  // Client → full scrub; internal → secrets/tokens only.
  const { text: redacted, redactions } = redactInternalArtifacts(text, audience);
  if (redactions.length > 0) {
    return {
      action: 'redact',
      text: redacted,
      reason: 'internal_artifact',
      redactions,
      opsEvidence: sanitizeOpsEvidence(text),
    };
  }

  return { action: 'allow', text };
}
