/**
 * Recursive metadata-only log sanitizer (WS-A06).
 *
 * Applied centrally at logger construction via Pino's `hooks.logMethod`,
 * this sanitizer walks every log merge object before serialization and
 * strips or masks content that must never be retained in logs:
 *
 * - Secret-bearing fields (password, token, credential, key, auth, …)
 * - Content-bearing fields (textPreview, message, content, body, prompt, …)
 * - Identity fields (jid, lid, conversationId, phone, email, …)
 * - URL userinfo, query, and fragment components
 * - Error messages and stack traces (replaced with bounded error class)
 * - Binary buffers (replaced with `[binary]` placeholder)
 *
 * The sanitizer is recursive, cycle-safe (WeakSet), and never throws.
 *
 * Design principle: truncation limits the number of retained bytes but does
 * not remove a sensitive value that occurs near the beginning of a preview.
 * This sanitizer removes the value entirely.
 */

// ─── Sensitive key patterns ─────────────────────────────────────────────────
//
// Keys whose values must never appear in logs regardless of content.
// Matched case-insensitively against the full key name.

const SECRET_KEY_RE =
  /^(pass|password|passwd|secret|token|credential|credentials|apikey|api_key|auth|authorization|cookie|session|privatekey|private_key|client_secret|access_token|refresh_token)$/i;

const CONTENT_KEY_RE =
  /^(text|textpreview|preview|message|msg|content|body|payload|prompt|response|result|response_text|output|raw|rawline|raw_line|line|snippet|chunk|html|xml|soap|caption|transcript)$/i;

const IDENTITY_KEY_RE =
  /^(jid|lid|conversationid|conversation_id|chatid|chat_id|phone|phonenumber|phone_number|email|e_mail|userid|user_id|account|accountid|account_id|sender|recipient|from|to|contact|name|displayname|display_name|pushname)$/i;

// Composite check: is this key sensitive in any category?
function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) || CONTENT_KEY_RE.test(key) || IDENTITY_KEY_RE.test(key);
}

// ─── String value sanitization ──────────────────────────────────────────────

// URL userinfo: ://user:pass@host → ://***@host
const URL_USERINFO_RE = /:\/\/[^\s/:@]+:[^\s/@]+@/g;
// URL query: ?param=value → ?***
const URL_QUERY_RE = /\?[^\s#]+/g;
// URL fragment: #anchor → #***
const URL_FRAGMENT_RE = /#[^\s]+/g;
// Email-like patterns in arbitrary strings
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Phone-like: 7+ consecutive digits with optional +
const PHONE_RE = /\+?\d{7,}/g;
// WhatsApp JID: digits@s.whatsapp.net or lid:something@something
const JID_RE = /[\d]+@s\.whatsapp\.net/gi;
// Bearer/API key patterns in strings
const BEARER_RE = /((?:bearer|api[_-]?key|token)\s*[=:]\s*)[\w-]+/gi;

function sanitizeStringValue(value: string): string {
  return value
    .replace(URL_USERINFO_RE, '://***@')
    .replace(URL_QUERY_RE, '?***')
    .replace(URL_FRAGMENT_RE, '#***')
    .replace(JID_RE, '***')
    .replace(BEARER_RE, '$1=***')
    .replace(EMAIL_RE, '***')
    .replace(PHONE_RE, '***');
}

// ─── Recursive sanitizer ────────────────────────────────────────────────────

const MAX_DEPTH = 10;

/**
 * Recursively sanitize a log merge value. Never throws.
 *
 * @param value The value to sanitize (object, array, primitive).
 * @param seen  WeakSet for cycle detection (internal).
 * @param depth Current recursion depth (internal).
 * @returns A sanitized copy; the original is never mutated.
 */
export function sanitizeLogValue(
  value: unknown,
  seen?: WeakSet<object>,
  depth: number = 0,
): unknown {
  // Primitives
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return '[symbol]';

  // Strings: sanitize inline
  if (typeof value === 'string') {
    return sanitizeStringValue(value);
  }

  // Depth guard
  if (depth >= MAX_DEPTH) return '[max-depth]';

  // Binary buffers
  if (Buffer.isBuffer(value)) return '[binary]';
  if (value instanceof Uint8Array) return '[binary]';
  if (value instanceof ArrayBuffer) return '[binary]';

  // Cycle detection for objects
  if (typeof value === 'object') {
    const seenSet = seen ?? new WeakSet<object>();
    if (seenSet.has(value as object)) return '[circular]';
    seenSet.add(value as object);

    // Error objects: extract bounded error class, drop message/stack
    if (value instanceof Error) {
      return {
        errorClass: value.constructor.name,
        ...(value.cause !== undefined
          ? { cause: sanitizeLogValue(value.cause, seenSet, depth + 1) }
          : {}),
      };
    }

    // Arrays
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeLogValue(item, seenSet, depth + 1));
    }

    // Plain objects: filter sensitive keys, recurse values
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        // Drop the value entirely — replace with bounded placeholder
        result[key] = '[redacted]';
      } else {
        result[key] = sanitizeLogValue(val, seenSet, depth + 1);
      }
    }
    return result;
  }

  // Fallback: stringify unknown types
  try {
    return String(value);
  } catch {
    return '[unstringifiable]';
  }
}

// ─── Pino hook integration ──────────────────────────────────────────────────

/**
 * Pino `hooks.logMethod` that sanitizes the merge object (first arg) before
 * it reaches Pino's serialization pipeline.
 *
 * Pino calls this as `hook.call(logger, args, method, level)` where:
 * - `args`   is the array of arguments passed to the log method
 * - `method` is the original log method (already bound to the logger)
 * - `level`  is the numeric level
 *
 * We mutate `args[0]` in-place when it is an object, then forward to `method`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pino's hook signature uses any for args/method; our runtime type guard on args[0] is the security boundary. expires 2026-12-31
export function sanitizingLogHook(
  this: unknown,
  args: any[],
  method: (...args: any[]) => void,
  _level: number,
): void {
  if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
    args[0] = sanitizeLogValue(args[0]) as Record<string, unknown>;
  }
  return method.apply(this, args);
}
