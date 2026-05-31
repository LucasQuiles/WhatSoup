# SEC2: FTS5 MATCH Injection via Raw User Input

**Severity:** High
**Source:** L audit finding H4
**Files:** `src/mcp/tools/search.ts:36-51`

## Problem

The `search_messages` and `search_chat_messages` MCP tools pass user-provided search queries directly into an FTS5 `MATCH` clause without sanitization. FTS5 has its own query syntax (AND, OR, NOT, NEAR, column filters, etc.). A crafted query like `* OR messages_fts` could cause:

1. Unexpected query expansion returning all rows
2. SQLite errors from malformed FTS expressions
3. Unbounded result sets (the `limit` parameter is also user-controlled with no cap)

## Fix

1. Sanitize FTS5 input: escape or strip FTS operators (`AND`, `OR`, `NOT`, `NEAR`, `*`, `"`, `(`, `)`)
2. Or: wrap user input in double quotes to treat as a literal phrase match
3. Cap `limit` parameter to a maximum of 100 (or configurable max)
4. Add try/catch around the MATCH query to return a clean error on malformed FTS

## Verification

- Unit test: query with FTS operators → sanitized or quoted
- Unit test: limit=99999 → capped to 100
- Unit test: malformed FTS expression → clean error, not crash
