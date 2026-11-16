# Contributing to WhatSoup

## DB-read helper naming convention

Functions whose first parameter is `db: Database` or `db: DatabaseSync` must use the `get` prefix (e.g. `getUsers`, `getSession`). The legacy prefixes `load` and `fetch` are reserved for non-DB I/O.

- **Ratchet enforcement**: `tests/scripts/db-read-prefix-budget.test.ts`
- **Editor feedback**: ESLint rule `eslint-rules/db-read-prefix.mjs`

## Private term file

This repository is public, so its checks cannot list the names they protect.
Keep your own machine, bot, people and address names in a private term file
outside the repository: `~/.config/whatsoup/private-terms.json`, or the path in
`WHATSOUP_PRIVATE_TERMS_FILE` (an empty value counts as unset). Every repository
hygiene mode, the pre-commit and pre-push hooks and the PR metadata check load it.
Without the file, the checks run only their generic and fallback rules and say so
in one line; `WHATSOUP_REQUIRE_PRIVATE_TERMS=1` makes a missing file a failure
(exit 2). A file that exists but cannot be read or applied always fails.

An example with invented names:

```json
{
  "schema": "whatsoup-private-terms",
  "version": 1,
  "contexts": ["com.whatsoup.{t}", "whatsoup@{t}", "instances/{t}/"],
  "terms": [
    {"id": "M001", "class": "machine", "value": "zorblab", "match": "word", "case": "insensitive", "replace": "host-a"},
    {"id": "F001", "class": "machine", "regex": "zmini([0-9]{1,2})", "match": "word", "case": "insensitive", "replace": "host-{1}"},
    {"id": "B001", "class": "instance", "value": "qx-bot", "match": "word", "case": "insensitive", "variants": true, "replace": "bot-a"},
    {"id": "C001", "class": "instance", "value": "zqline", "match": "context", "case": "sensitive", "replace": "line-a"},
    {"id": "P001", "class": "person", "value": "quorpine", "match": "word", "case": "insensitive", "replace": "user-a"},
    {"id": "D001", "class": "private-domain", "value": "corp-zz.example", "match": "literal", "case": "insensitive", "replace": "corp.example"},
    {"id": "N001", "class": "address", "value": "198.51.100.7", "match": "address", "case": "sensitive", "replace": "192.0.2.1"}
  ]
}
```

- `schema` and `version` are fixed: `whatsoup-private-terms`, `1`.
- `id`: unique per term, 1 to 32 characters of `A-Z`, `a-z`, `0-9`, `_` or `-`.
  Ids are printed (the anonymizer's report counts replacements by id), so use a
  neutral code such as `M001`. The loader refuses an id that any term rule or
  fallback rule matches. Findings never print the value.
- `class`: `machine`, `instance`, `person`, `person-user`, `person-surname`,
  `private-domain`, `account-id` or `address`. It picks the rule code a finding
  reports (for example `private-host-label` for `machine`).
- `value`, or `regex` for `word` and `context` terms. `literal` and `address`
  terms need a `value`.
- `match`:
  - `word`: a whole word;
  - `context`: only inside one of the `contexts` forms, where `{t}` marks the term;
  - `literal`: any substring;
  - `address`: an address that is not part of a longer one.
- `case`: `sensitive` or `insensitive`.
- `variants: true` widens a value ending in `-bot` to `x-bot`, `x_bot` and `xbot`.
- `replace`: the neutral name `scripts/anonymize-private-literals.ts` writes
  (`{1}` is the regex's first group). It may not contain another term.
- `contexts` on a single term replaces the top-level list for that term.

The private tree check (`npm run guard:repo:tree`, also a push-gate step) compares
every tracked file and path name at `HEAD` with a private baseline:
`~/.config/whatsoup/boundary-baseline.json`, or the path in
`WHATSOUP_BOUNDARY_BASELINE_FILE`, never committed. Build the first one once your
term file exists:

```sh
npm run guard:repo:tree:write-baseline -- --allow-increase
```

After that, a rise or a new file with hits fails the check; a fall passes with one
advisory line, and `npm run guard:repo:tree:write-baseline` lowers the counts. Raising
a count, adding a file or following a revised term file needs `--allow-increase`, and
the writer refuses unless `origin/main` is an ancestor of `HEAD`.
