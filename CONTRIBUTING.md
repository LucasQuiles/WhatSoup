# Contributing to WhatSoup

## DB-read helper naming convention

Functions whose first parameter is `db: Database` or `db: DatabaseSync` must use the `get` prefix (e.g. `getUsers`, `getSession`). The legacy prefixes `load` and `fetch` are reserved for non-DB I/O.

- **Ratchet enforcement**: `tests/scripts/db-read-prefix-budget.test.ts`
- **Editor feedback**: ESLint rule `eslint-rules/db-read-prefix.mjs`
