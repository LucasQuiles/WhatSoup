// src/lib/redaction-patterns.ts
// Canonical redaction patterns (SSOT). Consolidates the previously-divergent
// per-module WhatsApp-JID regexes so no log/diagnostic path under-redacts.

/**
 * Canonical WhatsApp-JID match pattern.
 *
 * Returns a FRESH RegExp on every call so the global (`/g`) `lastIndex` state is
 * never shared across call sites — safe for `.replace()` and for any future
 * `.test()`/`.exec()` use.
 *
 * Strict superset of every historical per-module copy: a 5+ digit id with an
 * optional device suffix (`-N`) AND/OR an optional port suffix (`:N`), on
 * `@s.whatsapp.net` / `@g.us` / `@lid`, case-insensitive. The prior copies each
 * dropped one of those dimensions (some missed `-N`, some missed `:N`, the
 * case-sensitive ones missed uppercase domains), so each under-redacted a class
 * of real JIDs; this pattern catches all of them.
 */
export function jidPattern(): RegExp {
  return /\b\d{5,}(?:-\d+)?(?::\d+)?@(s\.whatsapp\.net|g\.us|lid)\b/gi;
}
