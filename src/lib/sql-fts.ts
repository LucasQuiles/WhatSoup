// src/lib/sql-fts.ts
// SQLite FTS5 MATCH query safety. Pure utility, no dependencies — importable
// from any architectural layer (mcp, core, fleet, ...).
//
// Moved from src/fleet/db-reader.ts (#2242): the only external consumer,
// src/mcp/tools/search.ts, sits below the fleet ring, so the helper needed a
// shared home rather than an upward import.

/**
 * Build a safe FTS5 MATCH query from free-text input by quoting each
 * whitespace-separated token and AND-joining them, rejecting control
 * characters and embedded quotes that would otherwise break out of the
 * MATCH string literal.
 *
 * Single source of truth for FTS search. Consumed by `FleetDbReader`
 * (src/fleet/db-reader.ts) and the MCP search tools (src/mcp/tools/search.ts).
 */
export function buildSafeFtsMatchQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('Invalid FTS MATCH query: query must not be empty');
  }

  const unsafeCharPattern = new RegExp('["\\u0000-\\u001f\\u007f]', 'u');
  for (const token of tokens) {
    if (unsafeCharPattern.test(token)) {
      throw new Error('Invalid FTS MATCH query: unsafe characters are not allowed');
    }
  }

  return tokens.map((token) => `"${token}"`).join(' AND ');
}
