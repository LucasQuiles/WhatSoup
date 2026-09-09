import { jidPattern } from './redaction-patterns.ts';

// These expressions mirror the Python BOT ERRORS redaction SSOT. Bounds on the
// variable-width alternatives are intentional: the parity corpus includes adversarial
// inputs that previously caused quadratic backtracking.
const SECRETISH_ASSIGNMENT =
  /(^|[^A-Za-z0-9_]|\\n)(["']?(?:[A-Za-z0-9]+_)*(?:(?:[A-Za-z0-9_.-]{0,20}api[_-]?key[A-Za-z0-9_.-]{0,20})|client[_-]?secret|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|cookie|credential|password|passphrase|secret|session|token|[A-Za-z0-9]{1,40}(?:token|secret|password|passphrase|api[_-]?key)|pat)["']?\s*[:=]\s*["']?)((?:(?:Bearer|Basic)\s+)?[^\s\\,"';}]+)(["']?)/gi;
const AUTHORIZATION_BEARER = /\b(authorization\s*[:=]\s*(?:Bearer|Basic)\s+)[^\s\\"',;}]+/gi;
const AUTHORIZATION_KEYED =
  /(^|[^A-Za-z0-9_]|\\n)(["']?authorization["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\s)([^\s\\,"';}]+)(["']?)/gi;
const BEARER_VALUE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const WHATSAPP_SERVICE_UNIT = /\b(whatsoup@)(\d{8,16})(\.service)?\b/gi;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const CREDENTIAL_PATH =
  /(?:(?<![A-Za-z0-9._~-])~|(?<![A-Za-z0-9._~-])\/)[^\s"',;}]*?(?:\.config\/secrets\/[^\s"',;}]+|\.config\/whatsoup\/[^\s"',;}]+|\.local\/share\/whatsoup\/instances\/[^\s"',;}]*\/auth(?:\/[^\s"',;}]+)?|auth-bond-backups\/[^\s"',;}]+|\/(?:bot-errors\.env|fleet-token|fleet\.env|fleet-tokens\.json|tokens\.env|secrets\.env|\.env(?:\.[^\s"',;}]+)?))\b/gi;
const KEYED_PHONE_LIKE = /\b(phone|phone[_-]?number|msisdn|line)(\s*[:=]\s*|[\s_-]+)(\+?\d{10,16})\b/gi;
const CONTEXT_PHONE_LIKE = /\b(for)([\s_-]+)(\+?\d{10,16})\b/gi;
const PHONE_LIKE = /(^|[^\w])(\+?(?:\d[\d\s().-]{8,}\d))(?![\w])/g;

function redactPhoneLike(value: string): string {
  return value
    .replace(KEYED_PHONE_LIKE, (_match, key: string, separator: string) =>
      `${key}${separator}[REDACTED PHONE]`)
    .replace(CONTEXT_PHONE_LIKE, (_match, key: string, separator: string) =>
      `${key}${separator}[REDACTED PHONE]`)
    .replace(PHONE_LIKE, (match, prefix: string, candidate: string) => {
      const stripped = candidate.trim();
      if (/^\d+(?:\.\d+){2,}(?:[-+~][A-Za-z0-9.-]+)?$/.test(stripped)) {
        const runs = stripped.match(/\d+/g) ?? [];
        const totalDigits = runs.reduce((sum, run) => sum + run.length, 0);
        const longestRun = runs.reduce((maximum, run) => Math.max(maximum, run.length), 0);
        if (totalDigits > 15 || longestRun >= 5) return match;
      }
      if (/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}(?::\d{2}(?::\d{2})?)?)?$/.test(stripped)) {
        return match;
      }
      const digits = candidate.replace(/\D/g, '');
      const hasPhoneSyntax = stripped.startsWith('+') || /[\s().-]/.test(candidate);
      return hasPhoneSyntax && digits.length >= 10 && digits.length <= 15
        ? `${prefix}[REDACTED PHONE]`
        : match;
    });
}

const CRED_PATH_SAFE_PREFIXES = [
  '.config/secrets/',
  '.config/whatsoup/',
  '.local/share/whatsoup/instances/',
  'auth-bond-backups/',
] as const;

function safeShapeCredPathEnabled(): boolean {
  // env-allowed: lib cannot import config; config publishes this call-time gate.
  const raw = (process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function safeShapeCredentialPath(matched: string): string {
  for (const prefix of CRED_PATH_SAFE_PREFIXES) {
    const index = matched.indexOf(prefix);
    if (index !== -1) return `${matched.slice(0, index)}${prefix}[REDACTED]`;
  }
  return '[REDACTED CREDENTIAL PATH]';
}

function redactCredentialPath(value: string): string {
  if (safeShapeCredPathEnabled()) {
    return value.replace(CREDENTIAL_PATH, (matched) => safeShapeCredentialPath(matched));
  }
  return value.replace(CREDENTIAL_PATH, '[REDACTED CREDENTIAL PATH]');
}

/** Shared pure text projection used by BOT ERRORS and local forensic artifacts. */
export function redactText(value: string): string {
  return redactPhoneLike(redactCredentialPath(value
    .replace(PEM_PRIVATE_KEY, '[REDACTED PEM PRIVATE KEY]'))
    .replace(jidPattern(), '[REDACTED WHATSAPP JID]')
    .replace(
      WHATSAPP_SERVICE_UNIT,
      (_match, prefix: string, _digits: string, suffix?: string) =>
        `${prefix}[REDACTED PHONE]${suffix ?? ''}`,
    )
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .replace(AWS_ACCESS_KEY_ID, '[REDACTED AWS ACCESS KEY]')
    .replace(GITHUB_TOKEN, '[REDACTED GITHUB TOKEN]')
    .replace(JWT_VALUE, '[REDACTED JWT]')
    .replace(AUTHORIZATION_BEARER, '$1[REDACTED]')
    .replace(
      AUTHORIZATION_KEYED,
      (_match, pre: string, keySeparator: string, _value: string, closeQuote: string) =>
        `${pre}${keySeparator}[REDACTED]${closeQuote}`,
    )
    .replace(
      SECRETISH_ASSIGNMENT,
      (_match, pre: string, keySeparator: string, _value: string, closeQuote: string) =>
        `${pre}${keySeparator}[REDACTED]${closeQuote}`,
    )
    .replace(BEARER_VALUE, '$1[REDACTED]'));
}
