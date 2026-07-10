// Shared provider preview redaction for structured logs and any other surface
// that previews provider/agent text. Lives in `lib` (the lowest ring) so both
// runtime providers and core guardrails can reuse one sanitizer — SSOT, no
// duplicated token/secret regex islands.

import { jidPattern } from './redaction-patterns.ts';

const KEYED_SECRET_PREFIX = /(?<![A-Za-z0-9_.-])(["']?)(?:[A-Za-z0-9]+_)*(?:[A-Za-z0-9_.-]{0,20}api[_-]?key[A-Za-z0-9_.-]{0,20}|client[_-]?secret|private[_-]?key|signing[_-]?key|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|cookie|credential|password|passphrase|secret|session|token|[A-Za-z0-9]{1,40}(?:token|secret|password|passphrase|api[_-]?key)|pat)\1(?![A-Za-z0-9_.-])\s*[:=]\s*/gi;
const EMAIL_TOKEN_CHAR = /[A-Za-z0-9._%+@-]/;
const TRAILING_EMAIL_PUNCTUATION = new Set(['.', ':']);

function redactKeyedSecretValues(text: string): string {
  let cursor = 0;
  let out = '';
  for (const match of text.matchAll(KEYED_SECRET_PREFIX)) {
    const index = match.index;
    if (index < cursor) continue;
    const valueStart = index + match[0].length;
    out += text.slice(cursor, valueStart);
    const quote = text[valueStart];
    if (quote === '"' || quote === "'") {
      let end = valueStart + 1;
      let escaped = false;
      while (end < text.length) {
        const char = text[end]!;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          break;
        }
        end += 1;
      }
      const closed = text[end] === quote;
      out += `${quote}[REDACTED]${closed ? quote : ''}`;
      cursor = closed ? end + 1 : end;
      continue;
    }

    let end = valueStart;
    while (end < text.length && !/\s/.test(text[end]!)) end += 1;
    const value = text.slice(valueStart, end);
    out += value.length >= 8 ? '[REDACTED]' : value;
    cursor = end;
  }
  return out + text.slice(cursor);
}

function sanitizeProviderSecrets(text: string): string {
  return redactKeyedSecretValues(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs]|ya29|AIza)[-_A-Za-z0-9]{12,}\b/g, '[REDACTED_TOKEN]');
}

function redactEmailLikeTokens(text: string, preserveWhatsAppJids: boolean): string {
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
        while (emailEnd < text.length && /[A-Za-z0-9.-]/.test(text[emailEnd]!)) emailEnd += 1;
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
    let numericPrefix = true;
    while (index < text.length) {
      const char = text[index]!;
      if (EMAIL_TOKEN_CHAR.test(char)) {
        if (char < '0' || char > '9') numericPrefix = false;
        index += 1;
        continue;
      }
      if (char === ':' && numericPrefix) {
        let deviceEnd = index + 1;
        while (deviceEnd < text.length && /[0-9]/.test(text[deviceEnd]!)) deviceEnd += 1;
        if (deviceEnd > index + 1 && text[deviceEnd] === '@') {
          index = deviceEnd;
          numericPrefix = false;
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
    const jidMatch = preserveWhatsAppJids ? jidPattern().exec(core) : null;
    const preserve = jidMatch?.index === 0 && jidMatch[0].length === core.length;

    out += text.slice(cursor, start);
    out += preserve ? `${core}${suffix}` : `[REDACTED_EMAIL]${suffix}`;
    cursor = index;
  }
  return out + text.slice(cursor);
}

export function sanitizeProviderPreviewText(
  text: string,
  options: { preserveWhatsAppJids?: boolean } = {},
): string {
  const sanitized = sanitizeProviderSecrets(text);
  return redactEmailLikeTokens(sanitized, options.preserveWhatsAppJids === true);
}

export function providerPreview(text: string, maxLength: number): string {
  return sanitizeProviderPreviewText(text).slice(0, maxLength);
}
