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
 * - Error stack traces (dropped; they carry absolute filesystem paths)
 * - Error messages (bounded and passed through the same string sanitizer)
 * - Home-directory account segments in any retained text
 * - Binary buffers (replaced with `[binary]` placeholder)
 *
 * The sanitizer is recursive, cycle-safe (WeakSet), and never throws.
 *
 * Design principle: truncation limits the number of retained bytes but does
 * not remove a sensitive value that occurs near the beginning of a preview.
 * This sanitizer removes the value entirely.
 */

import { homePathPattern, jidPattern } from './redaction-patterns.ts';

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
// WhatsApp JID: the canonical SSOT pattern in ./redaction-patterns.ts. The
// sanitizer previously carried its own copy matching only digits@s.whatsapp.net,
// which let every @lid and @g.us address through, along with device (-N) and
// port (:N) suffixed forms. A short-id @lid also sits below PHONE_RE's
// seven-digit floor, so nothing else caught it.
//
// Secret-bearing tokens inside a string. The separator is OPTIONAL, so the
// canonical `Authorization: Bearer <token>` header form is covered; requiring
// [=:] matched only `token=...` and `api_key: ...` and missed the header. The
// eight-character floor keeps ordinary prose after a label ("authorization
// failed") out of the match, because over-scrubbing defeats the point of
// retaining a diagnostic message at all.
const BEARER_RE =
  /\b(bearer|api[_-]?key|authorization|token|secret|password|passphrase|pairing)\b(?:\s*[:=]\s*|\s+)["']?[\w.~+/-]{8,}={0,2}["']?/gi;

function sanitizeStringValue(value: string): string {
  return value
    .replace(URL_USERINFO_RE, '://***@')
    .replace(URL_QUERY_RE, '?***')
    .replace(URL_FRAGMENT_RE, '#***')
    .replace(homePathPattern(), '$1/***')
    .replace(jidPattern(), '***')
    .replace(BEARER_RE, '$1 ***')
    .replace(EMAIL_RE, '***')
    .replace(PHONE_RE, '***');
}

// ─── Bounded diagnostic text ────────────────────────────────────────────────

/**
 * Byte budget for diagnostic text retained from an Error. Long enough to carry
 * a real failure message, short enough that a runaway message cannot dominate
 * a log line. The truncation marker is charged against the same budget, so the
 * returned string never exceeds this length.
 */
const MAX_ERROR_TEXT_LENGTH = 512;
const TRUNCATION_MARKER = '[truncated]';

/**
 * Sanitize a diagnostic string, then bound it.
 *
 * Order is load-bearing: truncating first can split an email address or cut a
 * digit run below PHONE_RE's seven-digit floor, leaving behind a fragment the
 * pattern no longer matches. Sanitizing first means every pattern sees the
 * whole string.
 */
function boundedSanitizedText(value: string): string {
  const sanitized = sanitizeStringValue(value);
  if (sanitized.length <= MAX_ERROR_TEXT_LENGTH) return sanitized;
  return sanitized.slice(0, MAX_ERROR_TEXT_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Sentinel for a property whose read threw. A unique symbol, so it can never
 * collide with a legitimate property value.
 */
const UNREADABLE = Symbol('unreadable');

/**
 * Read one property off an Error without ever throwing.
 *
 * `message`, `code`, `cause` and `constructor` are ordinary properties: any of
 * them can be overwritten with a non-string or redefined as a throwing getter,
 * by application code or by a library we do not own. This sanitizer runs inside
 * pino's logMethod hook, so a throw here does not merely lose a log line — it
 * propagates into the caller that was trying to report a failure.
 */
function readErrorProperty(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return UNREADABLE;
  }
}

/** Coerce an already-read property to bounded, sanitized text. Never throws. */
function boundedErrorText(raw: unknown): string {
  if (typeof raw === 'string') return boundedSanitizedText(raw);
  if (raw === UNREADABLE) return '[unreadable]';
  if (raw === undefined || raw === null) return '';
  try {
    return boundedSanitizedText(String(raw));
  } catch {
    return '[unstringifiable]';
  }
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

    // Error objects: bounded class, bounded sanitized message, no stack.
    //
    // The message is the single most useful diagnostic field in the system.
    // Dropping it made pre-dispatch turn rejections journal
    // `err: {"errorClass":"Error"}` and nothing else, so the throw site could
    // not be identified after the fact; two agent-runtime call sites had
    // already worked around this locally with a sibling `errorMessage` field.
    //
    // Key names are deliberate. `message`, `msg` and `name` are all matched by
    // CONTENT_KEY_RE / IDENTITY_KEY_RE, so diagnostic text must travel under a
    // key the filters do not match — `errorMessage` also matches the existing
    // call-site convention in src/runtimes/agent/runtime.ts.
    //
    // The stack stays dropped: stacks carry absolute filesystem paths.
    if (value instanceof Error) {
      const constructorName = readErrorProperty(() => value.constructor?.name);
      const code = readErrorProperty(() => (value as Error & { code?: unknown }).code);
      const cause = readErrorProperty(() => (value as Error).cause);
      return {
        errorClass: typeof constructorName === 'string' ? constructorName : 'Error',
        errorMessage: boundedErrorText(readErrorProperty(() => value.message)),
        ...(typeof code === 'string' || typeof code === 'number'
          ? { errorCode: boundedErrorText(code) }
          : {}),
        ...(cause !== undefined && cause !== UNREADABLE
          ? { cause: sanitizeLogValue(cause, seenSet, depth + 1) }
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
  args: unknown[],
  method: (...a: unknown[]) => void,
  _level: number,
): void {
  if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
    args[0] = sanitizeLogValue(args[0]);
  }
  return method.apply(this, args);
}
