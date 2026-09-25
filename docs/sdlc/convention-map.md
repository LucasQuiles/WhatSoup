# WhatSoup Convention Map

Status: observed from `d24844ff51de396d692b0c659d8e71b0f89673df` on 2026-09-01,
then re-verified against `993a97435c1df66b96a23d26ee6e7ce3113d8c5f` before
publication. The re-verification checked the load-bearing structural claims —
the absence of a `.claude/skills` tree, the existence and population of every
named module directory, and the presence of every cited file — rather than
re-deriving the whole map, so the observation commit above remains the honest
source. This map records established repository practice; it does not grant
permission to deploy, publish, restart services, or modify credentials.

## Authority and precedence

- The workspace-level `AGENTS.md` owns portable workspace, git-safety, delegation, secret,
  and publication rules. Repository-specific architecture and commands come
  from `CLAUDE.md` and `docs/agent-operating-procedure.md`.
- Prefer current files and runtime evidence over session summaries. Record
  requested, configured, and observed runtime state separately; unknown stays
  unknown.
- Use global workflow skills by name. The repository deliberately carries no
  duplicate `.claude/skills` tree (`docs/agent-operating-procedure.md`).

## Repository and module layout

- Production TypeScript lives under `src/`; tests mirror source responsibilities
  under `tests/` (`CLAUDE.md`, `tests/fleet/platform.test.ts`).
- Shared infrastructure belongs in `src/core/`; transport and Baileys lifecycle
  in `src/transport/`; MCP registry and tools in `src/mcp/`; agent and chat
  runtimes in `src/runtimes/{agent,chat}/`; fleet/platform orchestration in
  `src/fleet/` (`CLAUDE.md`).
- Developer and CI tools live in `scripts/`. Host-shipped operational programs
  live in `deploy/scripts/`; Python deploy programs may use focused helpers in
  `deploy/scripts/lib/` but must remain independent of Node and cross-tree
  TypeScript imports (`docs/agent-operating-procedure.md`,
  `deploy/scripts/bot-errors-dispatcher.py`).
- Keep each change scoped to an existing responsibility. Search for reusable
  helpers before introducing another implementation; do not move or rename
  files merely to satisfy this map (`docs/agent-operating-procedure.md`).

## TypeScript, imports, and data contracts

- The project is ESM (`package.json#type`); use `import`/`export`, never CommonJS.
- Backend and test relative imports include explicit `.ts` extensions, as shown
  by `tests/fleet/platform.test.ts` and `src/fleet/platform.ts`. The Vite console
  uses bundler-mode extensionless imports; do not normalize one surface to the
  other's convention (`console/tsconfig*.json`).
- Node is pinned to `24.15.0`; use `scripts/run-with-pinned-node.sh` through the
  package scripts rather than an ambient Node executable (`package.json`,
  `.nvmrc`).
- Keep strict TypeScript contracts and check production plus test surfaces with
  `npm run typecheck:all`. Avoid unchecked shape widening at configuration and
  health boundaries (`tsconfig.json`, `tsconfig.test.json`).
- Zod is the common boundary validator, while configuration paths also use
  shared custom validators. Reuse the owning boundary's established validator;
  do not introduce a second schema source. Use discriminated results or typed
  domain errors for operational failure classes (`CLAUDE.md`, representative
  schemas and validators under `src/core/` and `src/fleet/`).
- Use Pino for structured runtime logging. Do not interpolate credentials,
  configuration contents, or raw identity data into error text (`CLAUDE.md`,
  `src/core/settings-template.ts`).

## Platform and service behavior

- Route service control through the platform abstraction in
  `src/fleet/platform.ts`; supported backends are `linux-systemd`,
  `macos-launchd`, `docker`, and `linux-no-systemd` (`CLAUDE.md`).
- Treat service-manager configuration as an input, not proof of the executing
  binary. Operational verification must inspect the live process and resolved
  code path in addition to plist/unit contents.
- Generated launchd values must be XML escaped. Plist options must preserve
  byte-identical output when absent, and tests must restore mutated environment
  variables (`tests/fleet/platform.test.ts`).
- Runtime activation, rollback, and observer jobs move as one release selector;
  update the owning runbook whenever code closes or changes a documented runtime
  gap (`CLAUDE.md`, `docs/runbooks/release-deployment.md`).

## Console conventions

- Console React components and pages generally use PascalCase filenames;
  utilities and hooks use kebab-case. Follow the containing directory because
  legacy export style is mixed (`console/src/`).
- Styling intentionally combines Tailwind utilities, shared CSS, semantic
  design tokens, and token-derived inline values. Do not replace one mechanism
  wholesale; run the console design and browser guards for touched surfaces
  (`package.json`, `console/package.json`).

## BOT ERRORS deployment contract

- Producers write durable, mode-restricted JSON events; the dispatcher owns
  network delivery, retry metadata, quarantine, incident state, and reporting
  (`deploy/scripts/bot-errors-dispatcher.py`).
- BOT ERRORS Python deploy surfaces are SHA-256 pinned in
  `deploy/bot-errors-runtime-manifest.json`. Any shipped-file change must update
  the pin and pass both `guard:bot-errors-runtime-manifest` and
  `guard:deployer-static` (`docs/agent-operating-procedure.md`, `package.json`).
- Persistent controller state is fail-closed: missing, malformed, stale, or
  masked evidence is inconclusive, never a clean result. Preserve recovery and
  rollback evidence when changing state schemas or retention behavior.
- One-shot observers cannot be assumed to retain cross-run state. When behavior
  depends on prior observations, use an explicit durable state owner and test
  restart/re-entry behavior.

## Testing conventions

- Use Vitest for TypeScript and real SQLite (`:memory:` or temporary files) and
  real Unix sockets where the behavior depends on them (`CLAUDE.md`).
- Run targeted tests with `npx vitest run --pool=forks <paths>`; use focused
  Python `pytest` modules for deploy-script behavior. Test observable behavior,
  failure classes, rollback, and state transitions rather than symbol presence.
- Behavior changes follow red -> green -> refactor. A red test must fail for the
  intended reason before implementation (`docs/agent-operating-procedure.md`).
- Restore process environment, timers, mocks, and caches in teardown. Prefer
  full-shape terminal assertions where partial assertions could mask a contract
  change (`tests/fleet/platform.test.ts`).
- `verify:push:branch` is curated and is not the full suite. Run every touched
  test directly, `npm run typecheck:all`, applicable guards, and the full/coverage
  lane in proportion to risk (`CLAUDE.md`, `package.json`).
- Skips, masked failures, fixture stderr, and unavailable platform checks must be
  labelled explicitly; none is evidence of a clean result.

## Documentation and SDLC artifacts

- Plans and specs live in `docs/superpowers/{plans,specs}/`; reviews and handoffs
  in their sibling directories; SDLC state in `docs/sdlc/{active,in-progress,closed}/`
  (`docs/agent-operating-procedure.md`).
- Durable cross-session operational receipts belong in the external project-state
  store, not in public repository prose.
- A code change that closes or alters a documented TODO, unwired behavior, or
  runtime gap updates that runbook in the same PR (`CLAUDE.md`).
- Public-surface line anchors and generated/pinned manifests are contracts; use
  their repository guards rather than hand-waving drift (`package.json`).

## Git, review, and publication

- Work in an isolated worktree from current SSH `origin/main`; do not implement
  from a stale shared checkout. Preserve unrelated user changes.
- Never use `git clean`, `git checkout --`, `git restore .`, or
  `git reset --hard`. Stash with `--include-untracked` only when preservation is
  required (workspace-level `AGENTS.md`).
- Before retiring a branch claimed as superseded, compare it with current main
  using `git cherry -v` and, for rewritten/squashed series, `git range-diff`.
  Preserve any unmatched tip under an explicit recovery/archive ref before
  deleting a worktree or branch.
- Use SSH remotes for `LucasQuiles` repositories. External writes, including
  pushes, PRs, reviews, merges, workflow reruns, and service mutations, require
  current owner authority naming or clearly entailing the action and target.
- Commit messages and public PR text must not contain model names, AI
  attribution, private host/instance labels, local home paths, personal/work
  email addresses, or `Co-Authored-By` trailers. Use conventional commit
  subjects and run the repository hygiene guards (workspace-level `AGENTS.md`,
  `docs/agent-operating-procedure.md`).

## Security and secrets

- Never print or copy credential values into commands, logs, chat, commits, or
  receipts. Use sanctioned credential wrappers and the system's own resolver;
  presence does not prove validity.
- On macOS, SSH, GUI, launchd, and wrapper-launched keychain visibility are
  distinct evidence surfaces. An SSH authentication result is non-authoritative
  until target-user keychain readability is proven (workspace-level `AGENTS.md`).
- Credential changes and service restarts are separate mutations. Verify the
  explicit authority and rollback path for each before acting.

## Exceptions and unknowns

- No code constitution is currently tracked; this map therefore derives
  authority from the files named above and current code patterns.
- Large legacy files exist in both TypeScript and deploy Python. Their size is
  not permission for an opportunistic split; extract only when a scoped change
  has characterization tests and a separately reviewable boundary.
- Several guards intentionally exercise failing fixtures and may print words
  such as `FAIL` inside an overall passing test. Judge the command's explicit
  exit/status and test attribution, not unscoped log grep.
