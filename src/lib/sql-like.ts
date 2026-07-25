// src/lib/sql-like.ts
// SQLite LIKE pattern safety. Pure utility, no dependencies — importable from
// any architectural layer (mcp, core, fleet, ...).

/**
 * Escape SQLite LIKE pattern metacharacters (`\`, `%`, `_`) so a caller's
 * query is matched literally rather than interpreted as wildcard syntax. Every
 * escaped value must be paired with an `ESCAPE '\'` clause on its `LIKE`
 * predicate.
 *
 * Single source of truth for substring search. Consumed by `search_contacts`
 * (src/mcp/tools/search.ts) and `list_chats` (src/mcp/tools/chat-management.ts).
 */
export function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
