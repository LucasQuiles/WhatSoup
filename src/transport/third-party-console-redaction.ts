import { jidPattern } from '../lib/redaction-patterns.ts';

type ConsoleMethodName = 'debug' | 'error' | 'info' | 'log' | 'warn';

type ConsolePatchTarget = Record<ConsoleMethodName, (...args: unknown[]) => void> & {
  [key: symbol]: unknown;
};

const PATCHED = Symbol.for('whatsoup.thirdPartyConsoleRedaction.v1');
const METHODS: ConsoleMethodName[] = ['debug', 'error', 'info', 'log', 'warn'];
const MAX_DEPTH = 5;
const MAX_KEYS = 40;
const MAX_ITEMS = 30;
const LIBSIGNAL_SESSION_DUMP_PREFIXES = [
  'Closing session:',
  'Removing old closed session:',
  'Opening session:',
  'Migrating session to:',
  'Session already closed',
  'Session already open',
] as const;

const SENSITIVE_KEY_RE = /(?:token|secret|password|passphrase|pairing|customcode|authorization|bearer|cookie|apikey|api_key|privatekey|private_key|clientsecret|client_secret|accesstoken|access_token|refreshtoken|refresh_token|credential|creds|authstate|auth_state|keydata|advsecretkey|signedidentitykey|identitykey|noisekey|signalkeys|sessionrecord|senderkey|senderkeymemory|appstatesynckey|ratchet|rootkey|basekey|chainkey|messagekeys|ephemeralkey|remoteidentitykey|lastremoteephemeralkey|pubkey|privkey)/i;

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function constructorName(value: object): string {
  return value.constructor?.name && value.constructor.name !== 'Object'
    ? value.constructor.name
    : 'Object';
}

export function redactThirdPartyConsoleString(value: string): string {
  return value
    .replace(/<Buffer(?:\s+[0-9a-f]{2})+>/gi, '<Buffer redacted>')
    .replace(jidPattern(), '<jid:redacted>')
    .replace(
      // QR-080: extend the free-text keyed-secret rule to compound-snake
      // (AWS_SESSION_TOKEN) and camelCase-glued (sessionToken/bearerToken) keys,
      // matching the QR-052/QR-079-hardened coverage. (Structured object KEYS are
      // already covered by SENSITIVE_KEY_RE; this closes the free-text-string path.)
      /\b((?:[A-Za-z0-9]+_)*(?:client[_-]?secret|private[_-]?key|signing[_-]?key|secret[_-]?access[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passphrase|authorization|bearer|session|[A-Za-z0-9]{1,40}(?:token|secret|password|passphrase|api[_-]?key)))\b\s*[:=]\s*[^\s"',}]+/gi,
      '$1=<redacted>',
    );
}

export function redactThirdPartyConsoleValue(
  value: unknown,
  key = '',
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (key && SENSITIVE_KEY_RE.test(key)) return '<redacted>';
  if (typeof value === 'string') return redactThirdPartyConsoleString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object' || value === null) return value;
  if (Buffer.isBuffer(value)) return `<Buffer redacted length=${value.length}>`;
  if (value instanceof Uint8Array) return `<Uint8Array redacted length=${value.byteLength}>`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      type: value.name,
      message: redactThirdPartyConsoleString(value.message),
      stack: value.stack ? redactThirdPartyConsoleString(value.stack) : undefined,
    };
  }
  if (seen.has(value)) return '<circular>';
  if (depth >= MAX_DEPTH) return '<max-depth>';
  seen.add(value);

  if (Array.isArray(value)) {
    const redacted = value.slice(0, MAX_ITEMS).map(item => redactThirdPartyConsoleValue(item, '', depth + 1, seen));
    if (value.length > redacted.length) redacted.push(`<truncated:${value.length - redacted.length}>`);
    return redacted;
  }

  if (!isPlainObject(value)) {
    return { type: constructorName(value), redacted: true };
  }

  const out: Record<string, unknown> = {};
  let redactedSensitiveFields = 0;
  let emitted = 0;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(childKey)) {
      redactedSensitiveFields += 1;
      continue;
    }
    if (emitted >= MAX_KEYS) {
      out['<truncated_keys>'] = Object.keys(value).length - emitted;
      break;
    }
    out[childKey] = redactThirdPartyConsoleValue(childValue, childKey, depth + 1, seen);
    emitted += 1;
  }
  if (redactedSensitiveFields > 0) out['<redacted_sensitive_fields>'] = redactedSensitiveFields;
  return out;
}

export function redactThirdPartyConsoleArgs(args: readonly unknown[]): unknown[] {
  return args.map(arg => redactThirdPartyConsoleValue(arg));
}

function shouldDropThirdPartyConsoleArgs(args: readonly unknown[]): boolean {
  const first = args[0];
  return (
    typeof first === 'string' &&
    LIBSIGNAL_SESSION_DUMP_PREFIXES.some(prefix => first.startsWith(prefix))
  );
}

export function installThirdPartyConsoleRedaction(target: ConsolePatchTarget = console as unknown as ConsolePatchTarget): void {
  if (target[PATCHED]) return;

  for (const method of METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      if (shouldDropThirdPartyConsoleArgs(args)) return;
      original(...redactThirdPartyConsoleArgs(args));
    };
  }

  Object.defineProperty(target, PATCHED, {
    value: true,
    enumerable: false,
    configurable: false,
  });
}
