# Trigger inventory response limits

`list_triggers` now limits each response to 50 rows and 65,536 bytes of compact
JSON. SQLite bounds legacy fields before transferring them into JavaScript.
Previously, an unfiltered request could materialize every row, including oversized
legacy values, in one tool response. Leaving that path available during a notice
period would retain the resource-exhaustion risk this change addresses.

Existing requests without `limit` or `after_id` still return the complete matching
inventory when it fits within both limits. Larger inventories return a
`pagination_required` error instead of a partial success that an older client
could mistake for complete data. This is a documented pre-stable compatibility
change to the beta `mcp:tools.substrate` surface.

To migrate a client:

1. Add `limit: 50` to its first `list_triggers` request, retaining existing filters.
2. Process the returned `triggers` array.
3. If `next_after_id` is non-null, pass it as `after_id` with the same filters.
   Continue until `next_after_id` is null, even if a page contains fewer than
   50 rows; the byte limit may end a page earlier.

Pagination does not provide a snapshot across concurrent changes. The read path
does not modify stored triggers or scheduling. Oversized text and invalid binary
fields appear as bounded over-limit space sentinels, with the original database
bytes preserved. SQLite integers outside JavaScript's safe integer range continue
to produce an error and require database repair before the affected page is read.

These controls do not establish a mandatory provider-spend budget. That remaining
acceptance criterion is tracked in [issue #3786](https://github.com/LucasQuiles/WhatSoup/issues/3786).
