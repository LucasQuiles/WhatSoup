# Working in WhatSoup

Use [README.md](README.md) for setup and usage, [the current program](docs/current-program.md)
for work discovery, and [the project map](docs/project-map.md) for architecture.
Read the relevant specification or runbook before changing its behavior.

## Commands and conventions

- Use the Node version declared in `.nvmrc` and `package.json`. Backend TypeScript
  runs through Node's native type stripping; the console has a separate build.
- Tests: `npm test`. Vitest uses a 10-second test timeout. Use
  `--pool=forks` for stability.
- Type checking: `npm run typecheck`.
- Source lint: `npm run guard:lint:src`. Architectural fitness warnings are advisory;
  lint errors and configuration faults fail the check.
- Use ESM, Zod for runtime validation and Pino for structured logging.
- Tests mirror source under `tests/`. Prefer real SQLite databases
  (`:memory:` or temporary files) and real Unix sockets when their behavior matters.
- [The agent operating procedure](docs/agent-operating-procedure.md) maps development
  phases to shared skills and repository checks. Do not duplicate shared skills
  under a repository-local `.claude/skills` directory.

## Behavior boundaries

Use canonical conversation identity, tool scope and instance configuration as
described in [the README](README.md#key-concepts),
[configuration reference](docs/configuration.md) and [tool reference](docs/tools.md).
MCP scope and agent-session lifetime are different concepts.

For blocking user decisions, use the supported `AskUserQuestion` poll bridge.
Use MCP `send_poll` for non-blocking surveys. Follow
[the decision-poll contract](docs/runbooks/agent-decision-polls.md).

## Verification and publication

Update a runbook in the same PR when a change resolves its documented gap.
Search affected runbooks for claims such as “not wired”, “TODO” or “not implemented”;
read each match in context. Stale claims about shipped behavior block release.

Local push checks cover a curated subset of CI. Both `verify:push:branch` and
`verify:release` use [the gate manifest](scripts/push-gate.ts); its
[registry test](tests/scripts/push-gate-manifest.test.ts) protects membership.
CI's `coverage:check` runs the full suite. A green push hook alone is insufficient.

Before pushing changes to tests, file sizes or fitness/coverage surfaces, run the
affected tests directly with `npx vitest run --pool=forks <test-files>`.
Preserve relevant negative cases; report skipped, masked and environment-blocked
checks as inconclusive. Follow [objective tracking](docs/runbooks/objective-tracking.md)
and [the quality checklist](docs/contributing/quality-guardrails-checklist.md).

## Release convergence

`main` is the only release line. Every host must run a release exported from
`main` or an ancestor of it. `scripts/release-export.ts` refuses any other
commit; restarts from a plain git checkout are not checked yet (see
[release deployment](docs/runbooks/release-deployment.md)). A deployed commit
that is not on `main` is backlog to land, not a second version to maintain.

- Work is done when it has landed on `main` and is deployed, or when the owner
  has discarded it. A branch, stash, worktree, mirror ref or ledger entry is not done.
- While unlanded work exists, fix forward on an existing pull request or the
  current `integration/convergence-*` branch. Do not create other branches or
  pull requests; a repository ruleset refuses other branch names on GitHub.
- One landing owner builds integration batches and merges them. Other sessions
  hand finished work to the landing owner through the hand-off record the owner
  names, instead of opening pull requests.
- When a pull request merges, delete its branch, worktree and stashes in the
  same session.

## Documentation ownership

- [Current program](docs/current-program.md): active-work navigation, not a copied backlog.
- [Project map](docs/project-map.md): source and documentation ownership.
- [Configuration](docs/configuration.md): environment, schemas and plugin scoping.
- [Tool reference](docs/tools.md): MCP API maintained against declarations; `guard:doc-drift` checks counts and module coverage, while schemas and behavior require source review.
- [Runbooks](docs/runbook.md): operations, recovery and troubleshooting.
- [Durability](docs/durability.md): durable state and recovery contracts.
- [Security handoffs](docs/security-handoffs/): open application-lifecycle security work.

Change the authoritative document when behavior or ownership changes. Link to it
from other surfaces. Do not require plan updates for trivial edits.
