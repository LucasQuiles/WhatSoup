// Shared provider preview redaction for structured logs and any other surface
// that previews provider/agent text. Lives in `lib` (the lowest ring) so both
// runtime providers and core guardrails can reuse one sanitizer — SSOT, no
// duplicated token/secret regex islands.

import { jidPattern } from './redaction-patterns.ts';

const ASSIGNMENT_DELIMITER = /[:=]/g;
const EMAIL_TOKEN_CHAR = /[A-Za-z0-9._%+@-]/;
const TRAILING_EMAIL_PUNCTUATION = new Set(['.', ':']);

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

function redactKeyedSecretValues(text: string): string {
  let cursor = 0;
  let out = '';
  for (const match of text.matchAll(ASSIGNMENT_DELIMITER)) {
    if (match.index < cursor) continue;
    const valueStart = keyedValueStart(text, match.index);
    if (valueStart === null) continue;
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
    out += value.length > 0 ? '[REDACTED]' : value;
    cursor = end;
  }
  return out + text.slice(cursor);
}

function sanitizeProviderSecrets(text: string): string {
  return redactKeyedSecretValues(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs]|ya29|AIza)[-_A-Za-z0-9]{12,}\b/g, '[REDACTED_TOKEN]');
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
        out += text.slice(cursor, index);
        out += '[REDACTED_EMAIL]';
        cursor = emailEnd;
        index = emailEnd;
        continue;
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
    const jidMatch = preserveWhatsAppJids ? jidPattern().exec(core) : null;
    const preserve = (jidMatch?.index === 0 && jidMatch[0].length === core.length)
      || (
        preserveWhatsAppMentions
        && /^@(?:\+?\d{5,}|[A-Za-z][A-Za-z0-9_-]*)$/.test(core)
      );

    out += text.slice(cursor, start);
    out += preserve ? `${core}${suffix}` : `[REDACTED_EMAIL]${suffix}`;
    cursor = index;
  }
  return out + text.slice(cursor);
}

export function sanitizeProviderPreviewText(
  text: string,
  options: { preserveWhatsAppJids?: boolean; preserveWhatsAppMentions?: boolean } = {},
): string {
  const sanitized = sanitizeProviderSecrets(text);
  return redactEmailLikeTokens(
    sanitized,
    options.preserveWhatsAppJids === true,
    options.preserveWhatsAppMentions === true,
  );
}

export function providerPreview(text: string, maxLength: number): string {
  return sanitizeProviderPreviewText(text).slice(0, maxLength);
}
