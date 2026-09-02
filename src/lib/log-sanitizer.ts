/**
 * Recursive pre-sink log sanitizer.
 *
 * Applied centrally at logger construction via Pino's `hooks.logMethod`, this
 * sanitizer walks every log merge object before serialization.
 *
 * WHAT IT REMOVES ENTIRELY
 * - Secret-bearing fields by key (password, token, credential, key, auth, …)
 * - Content-bearing fields by key (textPreview, message, content, body, …)
 * - Identity fields by key (jid, lid, conversationId, phone, email, …)
 * - Error stack traces
 * - Binary buffers (replaced with `[binary]`)
 *
 * WHAT IT MASKS IN PLACE, in any retained string
 * - URL userinfo, query, and fragment components
 * - WhatsApp JIDs, via the canonical pattern in ./redaction-patterns.ts
 * - Email addresses and phone-shaped digit runs
 * - Labelled bearer/API-key tokens
 * - The account segment of a POSIX home-directory path
 *
 * WHAT IT RETAINS — and why this file is NOT metadata-only
 * An Error reaching this sanitizer keeps a bounded, pattern-scrubbed copy of
 * its `message` under `errorMessage`, and of its `code`, when that is a string
 * or a number, under `errorCode`. Its `cause` is kept too: an Error cause is
 * recursed into the same shape, and a string cause gets the same budget as a
 * message. Free text therefore reaches the sink. The masking above is
 * pattern-based: it removes the shapes it knows and cannot remove an unshaped
 * secret or a sentence of private prose that happens to sit in an error
 * message.
 *
 * One retained shape is NOT bounded, and this is a disclosure, not an
 * oversight: an OBJECT cause is recursed with key filtering, so a string field
 * whose key the filters do not match is retained at whatever length it has. A
 * diagnostic string above the input ceiling is refused outright rather than
 * shortened, and reads `[oversized error]`.
 *
 * This narrows a live privacy acceptance. WS-A06 in
 * docs/superpowers/specs/2026-07-09-wall-to-wall-audit-remediation-design.md:214
 * requires that "synthetic canaries for message text, JID, phone, access token,
 * URL query/fragment, and malformed JSON are absent from every captured sink;
 * metadata and low-cardinality error class remain". Retaining message text is a
 * departure from the first clause of that acceptance.
 *
 * The same acceptance line has a second sentence, quoted here in full because
 * it is the one this change contradicts most directly: "Central key redaction
 * is paired with removal of free-text previews." This file pairs central key
 * redaction with the ADDITION of a free-text preview. Quoting only the first
 * sentence would understate the departure in the paragraph whose whole purpose
 * is to state it. WS-A06 is tracked by issue #2164 and was never mechanically
 * enforced: the artifacts its plan named
 * (tests/logger-privacy.test.ts, tests/fixtures/log-privacy-canary.ts,
 * src/lib/log-safety.ts) do not exist in this tree.
 *
 * The narrowing is pending an owner ruling. Do not describe this file as
 * metadata-only, and do not treat the pattern masking as equivalent to the
 * absence guarantee WS-A06 asks for. If the ruling reverses the narrowing, the
 * retention below is what has to change.
 *
 * The sanitizer is recursive, cycle-safe (WeakSet), and never throws.
 *
 * Design principle for the fields it drops: truncation limits retained length
 * but does not remove a sensitive value near the start of a preview, so those
 * values are removed entirely rather than shortened.
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
// Secret-bearing tokens inside a string.
//
// The separator is OPTIONAL, so the canonical `Authorization: Bearer <token>`
// header form is covered; requiring [=:] matched only `token=...` and
// `api_key: ...` and missed the header entirely.
//
// The length floor is CONDITIONAL, and that is the load-bearing detail. A
// single 8-character floor across both forms was measured against the pattern
// this replaced and silently dropped coverage for 18 of 120 fixture cells:
// every 5-, 6- or 7-character secret after `bearer`, `api_key` or `token` with
// a separator, which the previous pattern redacted because it had no floor at
// all. A 6-character pairing code after `token=` is exactly that shape.
//
// So: an explicit separator means the text that follows IS the value, and no
// floor applies. The floor survives only on the separator-less form, where the
// next token is as likely to be prose — it is what keeps "authorization failed"
// from becoming "authorization ***", and over-scrubbing would defeat the point
// of retaining a diagnostic message at all.
//
// Known cost, accepted: after a keyword AND a separator, prose is scrubbed too
// ("authorization: denied" becomes "authorization ***"). The previous pattern
// behaved the same way for its three keywords; this extends that behaviour to
// five more. Scrubbing is the safe direction when a separator says a value
// follows.
//
// The separator branch must not accept another label as its value. Without the
// lookahead, `Authorization: Bearer <token>` matches at `Authorization`,
// consumes `Bearer` as the value, and leaves the real token untouched — the
// exact header this pattern exists to cover.
//
// THE GUARD IS KEYED ON WHAT FOLLOWS THE NESTED LABEL: whitespace, `:` or `=`.
// Those three characters are what distinguish a label word that INTRODUCES the
// credential from one that merely begins it, and both readings have been wrong
// here before, in opposite directions.
//
// Keyed on a word boundary, the guard refused far too much. A credential whose
// VALUE begins with a label word and a separating character — the shape
// `token=secret-<credential>` — matched nothing at all and reached the sink
// verbatim. The cross-model bench's S0 measured that across a label x separator
// x value-prefix matrix.
//
// Keyed on whitespace alone, it then refused too little. `token=secret:
// <credential>` puts the credential after an INNER assignment; `secret:` is not
// followed by whitespace, so the guard admitted it, the value class consumed
// `secret:` and stopped at the space, and the credential was left standing in
// the clear. The cross-model bench raised that as a regression of the previous
// head. Adding `:` and `=` to the guard's follow set refuses the nested
// assignment, and the scan then matches at the inner label, so the credential
// is masked and the outer label survives as a readable cue.
//
// Requiring a following separator character rather than any word boundary is
// what keeps the S0 class masked: `secret-`, `token.`, `api_key-` and the rest
// are followed by none of the three, so the guard still admits them.
//
// The whitespace half of the follow set is also what keeps
// `Authorization: token <credential>` working: `token` IS followed by
// whitespace, so the guard refuses, and the separator-less branch masks the
// credential at the second label instead.
//
// Residual, disclosed: the guard refuses on those three characters whether or
// not a credential actually follows, so `token=secret at gate` is retained, and
// so are the trailing-separator forms `token=secret:` and `token=secret=`.
// Nothing in any of them is credential material — the value is the label word
// itself — but a real credential separated from a label word by a space is
// reached only by the separator-less branch, which carries an eight-character
// floor.
//
// Also unchanged and pre-existing: the value class stops at `,`, `;` and a
// quote, so `token=secret,<credential>` retains the text after the comma at
// every version of this pattern. That is the value class, not the guard.
//
// A LABEL IS MATCHED WHEREVER IT ENDS AN IDENTIFIER, AND ITS PREFIX IS NOT
// CONSUMED. The pattern this replaced had no anchor at all, so `token=` matched
// inside a longer identifier and `apiToken=<secret>` was masked. Anchoring the
// label with a leading \b dropped that whole class — `apiToken`, `authToken`,
// `accessToken`, `refreshToken`, `sessionToken`, `bearerToken`, `xapikey`,
// `my_token` — and nothing downstream catches it: PHONE_RE needs seven
// consecutive digits, EMAIL_RE needs an `@`, and the key filters do not apply
// to a substring sitting inside text that has already been retained.
// `access_token`, `refresh_token` and `token` are themselves SECRET_KEY_RE
// entries, so those values were removed as field names and kept inside
// messages.
//
// So the label alternation carries no leading anchor and no prefix run. The
// identifier characters in front of the label sit OUTSIDE the match, which is
// what makes the diagnostic still read back: `apiToken=<secret>` becomes
// `apiToken ***`, because `api` was never matched and only `Token=<secret>` is
// replaced. The trailing \b still applies, so the label must END the
// identifier; `tokenizer=<value>` is not a match.
//
// THERE IS NO PREFIX BOUND, and that is the point rather than an omission. An
// earlier shape here consumed the prefix as `[A-Za-z0-9_]{0,40}` and bounded it
// at 40 to cap prefix backtracking; the disclosed cost was that a label glued
// to 41 or more leading word characters was not recognised at all. Leaving the
// prefix unmatched removes the quantifier that had to be bounded instead of
// merely raising its ceiling, so there is no prefix run for a pathological
// input to rescan from every start position. The cross-model bench's LOW-5
// measured both shapes on a 50,000-character glued prefix and found them within
// noise of each other: that wall time is the pre-existing EMAIL_RE quadratic
// described below, not this pattern.
//
// KNOWN DIVERGENCE, deliberate and out of this change's scope: the two sibling
// redactors in this repo still consume the prefix and still bound it —
// SECRETISH_ASSIGNMENT in src/lib/bot-errors-outbox.ts and SECRETISH_ASSIGNMENT
// in src/lib/cli-redaction.ts both spell it `[A-Za-z0-9]{1,40}`, and both
// therefore keep the 41-character false negative this pattern no longer has.
// Those two and this one remain a three-way duplication of the same credential
// shape; consolidating them is a separate change, not one to make inside a fix.
// An HTTP authentication scheme can sit between the label and the credential.
// It is consumed as part of the match, BEFORE the not-another-label guard, for
// two reasons measured on this file: `Authorization: Basic <credential>` took
// `Basic` as the value and left the credential in the clear, and
// `Authorization: Bearer <short token>` matched nothing at all, because the
// guard rejected the authorization branch and the separator-less floor then
// rejected the short token.
const AUTH_SCHEMES = 'bearer|basic';
// A credential value runs to the next character that could end it. The token
// class this replaced stopped at the first character outside [\w.~+/-], so
// `password=Pw9@Xk2!Qm7` masked the leading `Pw9` and left the rest in the
// clear. The excluded set matches the sibling redactors named above.
const SECRET_VALUE = '[^\\s"\',;}\\\\]+';
const SECRET_LABELS = 'bearer|api[_-]?key|authorization|token|secret|password|passphrase|pairing';
const BEARER_RE = new RegExp(
  `((?:${SECRET_LABELS}))\\b`
    + `(?:\\s*[:=]\\s*(?:(?:${AUTH_SCHEMES})\\s+)?(?!(?:${SECRET_LABELS})[\\s:=])["']?${SECRET_VALUE}["']?`
    + `|\\s+["']?[\\w.~+/-]{8,}={0,2}["']?)`,
  'gi',
);

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
 * Budget for diagnostic text retained from an Error, in UTF-16 code units, not
 * bytes: every length in this file is a JavaScript string length, so an
 * astral-plane character counts twice and a multi-byte UTF-8 character may
 * serialize to more bytes than it is charged here. Long enough to carry a real
 * failure message, short enough that a runaway message cannot dominate a log
 * line. The truncation marker is charged against the same budget, so the
 * returned string never exceeds this length.
 */
const MAX_ERROR_TEXT_LENGTH = 512;
const TRUNCATION_MARKER = '[truncated]';

/**
 * Ceiling on the input a diagnostic string may have before the masking
 * patterns are allowed to run over it, in UTF-16 code units.
 *
 * EMAIL_RE (`[\w.+-]+@…`) backtracks quadratically over a long run of word
 * characters containing no `@`, and this runs synchronously inside pino's
 * logMethod hook, so the cost lands on the event loop on the error path. An
 * unbounded `Error.message` is a realistic input: one in-repo provider builds
 * its Error from a full, unsliced remote response body. Measured on this file:
 * 8,000 word characters cost 35 ms, 16,000 cost 125 ms, 32,000 cost 492 ms,
 * and 130,000 cost 8.3 s.
 *
 * Four times the retained budget is a generous ceiling — the output is at most
 * MAX_ERROR_TEXT_LENGTH either way.
 */
const MAX_SANITIZER_INPUT_LENGTH = MAX_ERROR_TEXT_LENGTH * 4;

/**
 * Stand-in for a diagnostic string too large to mask. Content-free by design:
 * it carries no fragment of the value it replaces.
 */
const OVERSIZED_MARKER = '[oversized error]';

/**
 * Sanitize a diagnostic string, then bound it.
 *
 * Order is load-bearing: truncating first can split an email address or cut a
 * digit run below PHONE_RE's seven-digit floor, leaving behind a fragment the
 * pattern no longer matches. Sanitizing first means every pattern sees the
 * whole string.
 *
 * That ordering is why an oversized string is REFUSED rather than shortened.
 * Clipping it first would reintroduce exactly the boundary cut the ordering
 * exists to prevent, at a point chosen by the length of the input rather than
 * by anything in it. Refusing costs a diagnostic; masking a fragment of an
 * unexamined value costs a secret. The refusal is total: no pattern is run
 * over the value, so the quadratic is never entered.
 */
function boundedSanitizedText(value: string): string {
  if (value.length > MAX_SANITIZER_INPUT_LENGTH) return OVERSIZED_MARKER;
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
          ? {
              // A cause is not always an Error. A string cause used to reach
              // the sink through the general recursion, which sanitizes but
              // does not bound, so it could carry far more retained text than
              // the message beside it. It gets the message's budget instead.
              // An object cause is still recursed with key filtering, and a
              // string field the filters do not match is retained in full.
              cause:
                typeof cause === 'string'
                  ? boundedSanitizedText(cause)
                  : sanitizeLogValue(cause, seenSet, depth + 1),
            }
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
