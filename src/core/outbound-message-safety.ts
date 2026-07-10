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
// This file performs NO logging, NO sending, and NO I/O. Callers (the MCP
// send_message path) decide what to do with a decision.
//
// SSOT note: the secret/token/email masking is reused from
// `sanitizeProviderPreviewText`. The internal-path / identifier / PII shapes
// here overlap with `scripts/repo-hygiene-guard.ts` and the BOT ERRORS outbox
// redactor; if a third consumer appears, extract a shared
// `src/lib/internal-artifact-patterns.ts` (deferred per YAGNI — one consumer now).

import { sanitizeProviderPreviewText } from '../lib/provider-preview-sanitizer.ts';
import { jidPattern } from '../lib/redaction-patterns.ts';

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
];

const ACK_FILLER_PATTERNS: readonly RegExp[] = [
  /^parked per\b.{0,80}\bdirective\b.{0,260}\b(?:no new evidence|no user ask|not reposting|holding until auth)\b/i,
  /^understood\b.{0,100}\b(?:deploy\b.{0,40}\bnoted|noted)\b.{0,260}\b(?:lane parked|won(?:'|’)t repost|pick\b.{0,80}\bback up)\b/i,
  /^understood\b.{0,80}\bholding\b.{0,260}\b(?:lcp\s+)?lane parked\b.{0,260}\bno further status pings\b/i,
  /^acknowledged\b.{0,140}\b(?:confirmed delivery|landed clean)\b.{0,260}\b(?:lane stays parked|nothing further to do)\b/i,
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
 *                  `WHATSOUP_INTERNAL_JIDS`; the fleet's own vocabulary (home/`~`
 *                  paths, `.claude/`, hook-event names, bead `Files:` lists) is
 *                  legitimate content there, so it is NOT scrubbed as a leak.
 *   - `client`   — everything else; the conservative default, since a false
 *                  redaction on an operator message is low-harm while a leak to
 *                  a real client is high-harm.
 * Shared by every agent free-text send tool (send/reply/edit/poll/media) so none
 * is a bypass.
 *
 * Reads `process.env.BOT_ERRORS_JID` and `process.env.WHATSOUP_INTERNAL_JIDS` —
 * the only runtime dependencies in this otherwise pure module; kept here so
 * audience policy has a single home.
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

export function resolveOutboundAudience(chatJid: string): OutboundAudience {
  const opsJid = process.env['BOT_ERRORS_JID']?.trim();
  if (opsJid && chatJid === opsJid) return 'ops';
  if (internalGroupJids().has(chatJid)) return 'internal';
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
const SENSITIVE_PATH_TOKEN = /(?<![A-Za-z0-9.-])(?:~|\/)[^\s"',;}\])>]+/g;
const CREDENTIAL_FILE_NAMES = new Set([
  'bot-errors.env',
  'fleet-token',
  'fleet.env',
  'fleet-tokens.json',
  'tokens.env',
  'secrets.env',
]);
const TRAILING_PATH_PUNCTUATION: ReadonlySet<string> = new Set(['.', ':', '`', '!', '?', '*', '_', '~']);
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
    while (end > 1 && TRAILING_PATH_PUNCTUATION.has(match[end - 1]!)) end -= 1;
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
 *   - `client`   — full scrub: secrets/emails, then operator paths, runtime
 *                  identifiers, and tailnet IPs.
 *   - `internal` — secrets/emails/sensitive credential paths only; operator
 *                  vocabulary is legitimate content in operator-owned agent
 *                  groups, so masking it there is over-redaction.
 *   - `ops`      — verbatim (BOT ERRORS needs raw diagnostics; its outbox
 *                  redactor scrubs secrets downstream).
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

  // Secret/token/email masking applies to client AND internal: WhatsApp is a
  // third-party transport, so a leaked credential is exposure even in an
  // operator-owned group. Internal WhatsApp JIDs are protected before this pass
  // because the generic email sanitizer otherwise treats `120...@g.us` as email.
  const sanitized = sanitizeProviderPreviewText(out, {
    preserveWhatsAppJids: audience === 'internal',
  });
  if (sanitized !== out) {
    redactions.push({ category: 'provider_secret', label: 'token-or-email' });
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
 * Ops sends are never rewritten. Internal sends have secrets/emails masked but
 * keep operator vocabulary. Client sends are diverted when they make a false
 * infra-failure claim, redacted when they leak an internal artifact, and
 * otherwise allowed unchanged.
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

  // Client → full scrub; internal → secrets/emails only.
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
