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

export type OutboundAudience = 'client' | 'ops' | 'internal';

export type OutboundMessageSafetyAction = 'allow' | 'redact' | 'divert';

export type RedactionCategory =
  | 'home_path'
  | 'internal_identifier'
  | 'tailnet_ip'
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
  reason?: 'internal_artifact' | 'false_infra_block_claim';
  redactions?: Redaction[];
  /** Sanitized diagnostic for ops/BOT ERRORS — PII/secret/username-free. */
  opsEvidence?: string;
}

/** Generic, non-technical text shown to a client when the original is diverted. */
export const CLIENT_TEMPORARY_ISSUE_TEXT =
  'I hit a temporary issue and am retrying. I will follow up shortly.';

// --- Internal-artifact shapes (linear / ReDoS-safe; no nested quantifiers) ---

// Absolute home directory paths and everything that hangs off them. The user
// segment is intentionally generic; the repo-hygiene allow-list does not apply
// here because the guardrail must mask every operator path at runtime.
const HOME_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g;
// The home-prefix alone, for ops evidence (mask the username, keep structure).
const HOME_PATH_USER = /(\/(?:Users|home)\/)[A-Za-z0-9._-]+/g;
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
// PII shapes for ops-evidence sanitization (mirror BOT ERRORS outbox posture).
const WHATSAPP_JID = /\b\d{5,}(?:-\d+)?@(?:s\.whatsapp\.net|g\.us|lid)\b/gi;
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

/**
 * Mask operator-local paths and internal runtime identifiers in CLIENT-bound
 * text. Tokens/emails are stripped via the shared provider sanitizer first.
 * Returns the cleaned text plus a categorised (non-sensitive) redaction list.
 */
export function redactInternalArtifacts(text: string): { text: string; redactions: Redaction[] } {
  const redactions: Redaction[] = [];
  let out = text;

  const sanitized = sanitizeProviderPreviewText(out);
  if (sanitized !== out) {
    redactions.push({ category: 'provider_secret', label: 'token-or-email' });
    out = sanitized;
  }

  // Full home paths first so a path + dotfile tail collapses to one marker
  // before the standalone-identifier pass can fire inside it.
  if (HOME_PATH.test(out)) {
    out = out.replace(HOME_PATH, '[internal-path]');
    redactions.push({ category: 'home_path', label: 'home-path' });
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
  // plural "tools (are|is) ... blocked" — self-infra, not "the booking tool is blocked"
  /\b(?:all\s+)?(?:my\s+|the\s+)?tools\s+(?:are|is)\s+(?:being\s+|currently\s+)?blocked\b/i,
  /\bcannot\s+(?:run|use|access|call)\s+(?:any\s+)?(?:of\s+my\s+)?tools\b/i,
  /\bfailing\s+closed\b/i,
  /\bagent[\s-]?sandbox\b[^.]*\b(?:failing|blocked|closed)\b/i,
  /\bsandbox[\s-]?policy(?:\.json)?\b[^.]*\b(?:missing|not\s+found|gone)\b/i,
  /\bpolicy\s+file\b[^.]*\b(?:missing|not\s+found|gone)\b/i,
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
  let out = sanitizeProviderPreviewText(text);
  out = out.replace(HOME_PATH_USER, '$1[redacted-user]');
  out = out.replace(WHATSAPP_JID, '[redacted-jid]');
  out = maskPhoneLike(out);
  return out;
}

/**
 * Decide how a single outbound message should be handled for its audience.
 * Ops/internal sends are never rewritten. Client sends are diverted when they
 * make a false infra-failure claim, redacted when they leak an internal
 * artifact, and otherwise allowed unchanged.
 */
export function evaluateOutboundMessageSafety(
  input: OutboundMessageSafetyInput,
): OutboundMessageSafetyDecision {
  const { text, audience } = input;

  if (audience !== 'client') {
    return { action: 'allow', text };
  }

  if (classifyInfraStatusClaim(text)) {
    return {
      action: 'divert',
      text: CLIENT_TEMPORARY_ISSUE_TEXT,
      reason: 'false_infra_block_claim',
      opsEvidence: sanitizeOpsEvidence(text),
    };
  }

  const { text: redacted, redactions } = redactInternalArtifacts(text);
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
