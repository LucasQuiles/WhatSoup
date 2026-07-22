// Shared provider preview redaction for structured logs and any other surface
// that previews provider/agent text. Lives in `lib` (the lowest ring) so both
// runtime providers and core guardrails can reuse one sanitizer — SSOT, no
// duplicated token/secret regex islands.

import { jidPattern } from './redaction-patterns.ts';

const ASSIGNMENT_DELIMITER = /[:=]/g;
const EMAIL_TOKEN_CHAR = /[A-Za-z0-9._%+@-]/;
const TRAILING_EMAIL_PUNCTUATION = new Set(['.', ':']);

// E9 (packet D5), narrowed by B25: an email-SHAPED core needs a NON-EMPTY
// local part AND a non-empty domain part around an '@'. A bare
// whitespace-flanked '@' used as the word "at" ("meet @ 5pm", "3 @ $5 each")
// carries no address and must pass through. Mention-shaped tokens ('@name',
// '@15551234567') are not email-shaped either, but they stay governed by
// preserveWhatsAppMentions below — phone mentions are PII on surfaces that
// did not opt in, so requiring a non-empty local part for the EMAIL match
// must not turn that flag into dead code.
//
// B25 REVERSAL of the original "x@" edge decision: a DANGLING-LOCAL token
// (non-empty local + trailing '@' + empty domain, e.g. '15551234567@',
// 'user@', the local half of a space-split address) is an ADDRESS FRAGMENT
// and now REDACTS. The original ruling said "redacting it protects nothing";
// the B25 review proved the opposite — on CLIENT egress there is no
// downstream phone masking (unlike the handoff/ops surfaces), so the
// fragment alone carries the whole PII payload. The E9 exemption therefore
// narrows to truly-bare '@' runs.
// B25 simplification (review's "/@[^@]/" note, adjusted): with dangling
// locals redacting, the three redactability predicates — email-shaped
// /[^@]@+[^@]/, mention-shaped ('@' + content), dangling-local /[^@]@+$/ —
// collapse to "the core is NOT a bare '@' run". Proof (a core always
// contains at least one '@'): if it also has any non-'@' char, then either
// it starts with '@' (mention-shaped) or its first '@' run is preceded by a
// non-'@' char and is either followed by one (email-shaped) or terminal
// (dangling local). The literal /@[^@]/ form would NOT be equivalent
// ('user@' must redact yet has no char after its '@'), hence the
// ALL_AT_SIGNS complement.
const ALL_AT_SIGNS = /^@+$/;
// B25 (1b) direction ruling: WhatsApp WIRE mentions are '@' + the numeric
// user part of a JID (phone or lid digits); typed courtesy mentions are
// username-ish. Dotted bodies ('@team.leads', '@foo.bar') can never be a
// deliverable email address — the local part is EMPTY — so accepting dots in
// the PRESERVE regex cannot leak a real email (an email-shaped core has a
// non-empty local and can never match this ^@-anchored regex). The regex
// stays fail-closed two ways: without the preserveWhatsAppMentions flag the
// token still redacts, and digit-led dotted bodies ('@1234.5678' — phone
// fragments) never match even WITH the flag.
const PRESERVABLE_MENTION = /^@(?:\+?\d{5,}|[A-Za-z][A-Za-z0-9._-]*)$/;

// T8-F3 (E4 fix): shared token-prefix alternation. Defined ONCE so the known-token
// mask (sanitizeProviderSecrets, below) and the truncation carve-out (in
// redactKeyedSecretValues) can never drift apart — a prefix recognized by one MUST
// be recognized by the other (packet: "SHARE that regex ... so they cannot drift").
const KNOWN_TOKEN_PREFIX = '(?:sk|pk|rk|ghp|github_pat|xox[baprs]|ya29|AIza)';
const KNOWN_TOKEN_RE = new RegExp(`\\b${KNOWN_TOKEN_PREFIX}[-_A-Za-z0-9]{12,}\\b`, 'g');
const KNOWN_TOKEN_PREFIX_RE = new RegExp(`^${KNOWN_TOKEN_PREFIX}`);

// T8-F3 (E4 fix): a value truncated for DISPLAY (backtick-wrapped, ending in an
// ellipsis) has already destroyed whatever it previews — masking it protects
// nothing and destroys operator usability (e.g. `` Session: `4947004d...` ``).
// The carve-out is TIGHT (packet: "the WIDTH is the security decision"): the base
// (chars before the trailing ellipsis, inside the backticks) must be SHORT
// (<= MAX_TRUNCATED_DISPLAY_BASE) AND must NOT match a known token prefix — a
// long truncated secret prefix (20+ chars, e.g. `sk-...` plus a long run) still
// masks, and a short-but-token-prefixed base (e.g. `sk-...` plus a short run)
// still masks. Anything else keeps today's behavior.
const MAX_TRUNCATED_DISPLAY_BASE = 12;
const TRUNCATED_DISPLAY_VALUE_RE = /^`([^`]*?)(?:\.\.\.|…)`$/;
const PROVIDER_ALIAS_PREVIEW_RE = /(?:⟦WSA1:[^\s⟧]{0,256}⟧?|[［\[]WSA1[^\s\]\uff3d]{0,256}[\]\uff3d]?|WSA1[:：][^\s]{0,256})/gu;

function isDisplayTruncatedNonSecret(value: string): boolean {
  const match = TRUNCATED_DISPLAY_VALUE_RE.exec(value);
  if (!match) return false;
  const base = match[1]!;
  return base.length <= MAX_TRUNCATED_DISPLAY_BASE && !KNOWN_TOKEN_PREFIX_RE.test(base);
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[.-]+/g, '_');
  const apiKeyMarker = /api_?key/g;
  for (const match of normalized.matchAll(apiKeyMarker)) {
    const prefixLength = match.index;
    const suffixLength = normalized.length - match.index - match[0].length;
    if (prefixLength <= 20 && suffixLength <= 20) return true;
  }
  return /(?:token|secret|password|passphrase|api_?key)$/.test(normalized)
    || /(?:^|_)(?:private_?key|signing_?key|secret_?access_?key|cookie|credential|session|pat)$/.test(normalized);
}

function keyedValueStart(text: string, delimiterIndex: number): number | null {
  let keyEnd = delimiterIndex;
  while (keyEnd > 0 && /\s/.test(text[keyEnd - 1]!)) keyEnd -= 1;
  let keyStart = keyEnd;
  const closingQuote = text[keyEnd - 1];
  if (closingQuote === '"' || closingQuote === "'") {
    let contentStart = keyEnd - 1;
    while (contentStart > 0 && /[A-Za-z0-9_.-]/.test(text[contentStart - 1]!)) contentStart -= 1;
    if (text[contentStart - 1] !== closingQuote) return null;
    keyStart = contentStart - 1;
    if (!isSecretKey(text.slice(contentStart, keyEnd - 1))) return null;
  } else {
    while (keyStart > 0 && /[A-Za-z0-9_.-]/.test(text[keyStart - 1]!)) keyStart -= 1;
    if (keyStart === keyEnd || !isSecretKey(text.slice(keyStart, keyEnd))) return null;
  }
  if (keyStart > 0 && /[A-Za-z0-9_]/.test(text[keyStart - 1]!)) return null;
  let valueStart = delimiterIndex + 1;
  while (valueStart < text.length && /\s/.test(text[valueStart]!)) valueStart += 1;
  return valueStart;
}

interface KeyedSecretValue {
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly quote: '"' | "'" | null;
  readonly closed: boolean;
  readonly redact: boolean;
}

function keyedSecretValues(text: string): KeyedSecretValue[] {
  const values: KeyedSecretValue[] = [];
  let consumedThrough = 0;
  for (const match of text.matchAll(ASSIGNMENT_DELIMITER)) {
    if (match.index < consumedThrough) continue;
    const valueStart = keyedValueStart(text, match.index);
    if (valueStart === null) continue;
    const opening = text[valueStart];
    if (opening === '"' || opening === "'") {
      let valueEnd = valueStart + 1;
      let escaped = false;
      while (valueEnd < text.length) {
        const char = text[valueEnd]!;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === opening) break;
        valueEnd += 1;
      }
      const closed = text[valueEnd] === opening;
      values.push({
        valueStart,
        valueEnd,
        quote: opening,
        closed,
        redact: true,
      });
      consumedThrough = closed ? valueEnd + 1 : valueEnd;
      continue;
    }
    let valueEnd = valueStart;
    while (valueEnd < text.length && !/\s/.test(text[valueEnd]!)) valueEnd += 1;
    const value = text.slice(valueStart, valueEnd);
    values.push({
      valueStart,
      valueEnd,
      quote: null,
      closed: false,
      redact: value.length > 0 && !isDisplayTruncatedNonSecret(value),
    });
    consumedThrough = valueEnd;
  }
  return values;
}

function redactKeyedSecretValues(text: string): string {
  let cursor = 0;
  let out = '';
  for (const value of keyedSecretValues(text)) {
    out += text.slice(cursor, value.valueStart);
    if (value.quote !== null) {
      out += `${value.quote}[REDACTED]${value.closed ? value.quote : ''}`;
      cursor = value.closed ? value.valueEnd + 1 : value.valueEnd;
      continue;
    }
    const rawValue = text.slice(value.valueStart, value.valueEnd);
    out += value.redact ? '[REDACTED]' : rawValue;
    cursor = value.valueEnd;
  }
  return out + text.slice(cursor);
}

export function sanitizeProviderSecrets(text: string): string {
  return redactKeyedSecretValues(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(KNOWN_TOKEN_RE, '[REDACTED_TOKEN]');
}

/** Secret-only predicate for fail-closed provider boundaries. */
export function containsProviderSecretValue(text: string): boolean {
  if (/Bearer\s+[A-Za-z0-9._~+/=-]+/i.test(text)) return true;
  KNOWN_TOKEN_RE.lastIndex = 0;
  if (KNOWN_TOKEN_RE.test(text)) return true;
  return keyedSecretValues(text).some((value) => value.redact);
}

function redactEmailLikeTokens(
  text: string,
  preserveWhatsAppJids: boolean,
  preserveWhatsAppMentions: boolean,
): string {
  let cursor = 0;
  let out = '';
  let index = 0;
  while (index < text.length) {
    const openingQuote = text[index];
    if (openingQuote === '"' || openingQuote === "'") {
      let quoteEnd = index + 1;
      let escaped = false;
      while (quoteEnd < text.length) {
        const char = text[quoteEnd]!;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === openingQuote) break;
        quoteEnd += 1;
      }
      if (text[quoteEnd] === openingQuote && text[quoteEnd + 1] === '@') {
        let emailEnd = quoteEnd + 2;
        if (text[emailEnd] === '[') {
          const bracketEnd = text.indexOf(']', emailEnd + 1);
          emailEnd = bracketEnd === -1 ? text.length : bracketEnd + 1;
        } else {
          while (emailEnd < text.length && /[A-Za-z0-9.-]/.test(text[emailEnd]!)) emailEnd += 1;
        }
        // B25 (1a): the same email-shaped requirement that gates the token
        // scanner below gates this branch — a NON-EMPTY domain must follow
        // the '@'. The old code redacted after scanning ZERO domain chars,
        // so quoted speech followed by the word "at" ('she said "hi"@ 5pm')
        // became [REDACTED_EMAIL]. With an empty domain we fall through to
        // the ordinary scanner, which tokenizes the quoted text and the bare
        // '@' separately (the quote breaks the token), so nothing redacts.
        if (emailEnd > quoteEnd + 2) {
          out += text.slice(cursor, index);
          out += '[REDACTED_EMAIL]';
          cursor = emailEnd;
          index = emailEnd;
          continue;
        }
      }
    }
    if (!EMAIL_TOKEN_CHAR.test(text[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < text.length) {
      const char = text[index]!;
      if (EMAIL_TOKEN_CHAR.test(char)) {
        index += 1;
        continue;
      }
      if (char === ':' && /^\d{5,}(?:-\d+)?$/.test(text.slice(start, index))) {
        let deviceEnd = index + 1;
        while (deviceEnd < text.length && /[0-9]/.test(text[deviceEnd]!)) deviceEnd += 1;
        if (deviceEnd > index + 1 && text[deviceEnd] === '@') {
          index = deviceEnd;
          continue;
        }
      }
      break;
    }
    const token = text.slice(start, index);
    if (!token.includes('@')) continue;

    let coreEnd = token.length;
    while (coreEnd > 0 && TRAILING_EMAIL_PUNCTUATION.has(token[coreEnd - 1]!)) coreEnd -= 1;
    const core = token.slice(0, coreEnd);
    const suffix = token.slice(coreEnd);
    // E9 (packet D5) + B25: only a truly-bare '@' run is exempt — every
    // other '@'-bearing core is email-shaped, mention-shaped, or a
    // dangling-local address fragment (equivalence proven at ALL_AT_SIGNS
    // above) and redacts unless a preserve rule below claims it. A bare run
    // is left in place via the pending-slice cursor, like the no-'@' case.
    if (ALL_AT_SIGNS.test(core)) continue;
    const jidMatch = preserveWhatsAppJids ? jidPattern().exec(core) : null;
    const preserve = (jidMatch?.index === 0 && jidMatch[0].length === core.length)
      || (preserveWhatsAppMentions && PRESERVABLE_MENTION.test(core));

    out += text.slice(cursor, start);
    out += preserve ? `${core}${suffix}` : `[REDACTED_EMAIL]${suffix}`;
    cursor = index;
  }
  return out + text.slice(cursor);
}

export interface ProviderPreviewSanitizerOptions {
  preserveWhatsAppJids?: boolean;
  preserveWhatsAppMentions?: boolean;
  /**
   * B25 chat-scope (owner ruling 2026-07-19): email redaction is a
   * BACKGROUND-ONLY function — for text handed to third-party providers
   * (previews, structured logs, handoff summarizers). Default TRUE, so every
   * background caller keeps full behavior with zero changes. Chat egress
   * (redactInternalArtifacts) passes FALSE, which skips the email-class pass
   * ENTIRELY — token path, quoted-local path, and dangling-local alike —
   * while secret/token/credential masking stays fully active. When false,
   * the two preserve* flags are inert (they only parameterize the email pass).
   */
  redactEmailLike?: boolean;
}

export function sanitizeProviderPreviewText(
  text: string,
  options: ProviderPreviewSanitizerOptions = {},
): string {
  const sanitized = sanitizeProviderSecrets(text).replace(
    PROVIDER_ALIAS_PREVIEW_RE,
    '[REDACTED_PROVIDER_ALIAS]',
  );
  if (options.redactEmailLike === false) return sanitized;
  return redactEmailLikeTokens(
    sanitized,
    options.preserveWhatsAppJids === true,
    options.preserveWhatsAppMentions === true,
  );
}

export function providerPreview(text: string, maxLength: number): string {
  return sanitizeProviderPreviewText(text).slice(0, maxLength);
}
