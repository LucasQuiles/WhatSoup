# WhatSoup Env-Secret Exposure — Implementation Kickoff

**Companion to:** [`2026-05-09-env-secret-exposure.md`](2026-05-09-env-secret-exposure.md) (the finding)
**Status:** pending — awaiting implementation
**Owner:** WhatSoup application/runtime
**Discovered:** 2026-05-09

The companion finding doc has the **what** and the **why**. This doc has the **how** — a phased non-destructive migration with constraints, current repo state, anti-patterns, and acceptance criteria. Read this entire doc before starting Phase A.

---

## Operational constraints (load-bearing — read before scoping)

These come from the originating user directive and the threat model. Violating any one of them invalidates the migration:

- **Non-destructive.** No phase may delete existing credentials, hard-restart the runtime, or require a one-shot replacement of the wrapper chain. Each phase must be incrementally reversible. Roll-forward, never roll-the-rug.
- **Maintain existing keys and credentials.** The keychain entries that back the current wrapper chain must keep working until every consumer has migrated. Don't pre-emptively rotate or delete them.
- **Portable.** macOS (Security.framework via CLI) and Linux (Secret Service via `secret-tool`) backends both required. CI/test environments need an explicit env fallback that is OFF by default in production.
- **Compatible.** Existing launchd plists, systemd units, and deploy scripts must keep functioning across the migration. The wrapper chain (`with-pinecone-env → with-openai-env → with-health-token → node`) is removed only in the final phase, after all consumers read via the resolver.
- **Durable.** The fix must survive macOS major-version upgrades, Node version bumps, and runtime reboots without manual recovery. The resolver should not depend on transient process state or session-specific keychain unlock semantics.
- **Secure.** Close the documented exposure (env vars visible to same-user `ps eww`) without opening new gaps: no secrets in process arguments, stack traces, logs, unhandled errors, or temp files. No secrets at rest outside the keyring backends.

---

## Credential handling — non-destructive migration discipline (CRITICAL)

This section is load-bearing. Skim it once. Internalize it. Re-read it before any phase that touches credential storage or any provider's auth path. The most expensive failure mode in this work is a migration that leaves the system unable to authenticate, and that failure mode is one careless deletion or one mishandled lookup away on every phase.

### Threat model — how credentials get destroyed during refactors

Every "clean up the old way" instinct is dangerous in this work. Patterns that have caused outages in similar migrations include:

- **Premature decommission.** Migrating from env-var loading to keyring loading, then deleting the env-var setup before verifying every consumer works through the keyring. The first request that hits an unmigrated consumer fails silently and authentication breaks.
- **Move-not-copy migration.** A script that "moves" a credential from one store to another (e.g. from `tokens.env` to a keyring entry) fails partway through — old location partially wiped, new location partially populated, neither works.
- **Test pollution.** Unit or smoke tests that read from or write to a real keyring, real `secret-tool`, or real `tokens.env`. A single test cleanup hook can delete a production credential. Tests must mock subprocess invocations of `security` and `secret-tool`, never spawn them against real backends.
- **Account-mismatch lookups.** Code that calls keyring lookups with the wrong account (deriving from `os.userInfo()` when the credential was stored under a different account, or omitting the account parameter and matching the first match arbitrarily). The lookup returns null, the code interprets that as "credential not configured", and either fails open or refuses to start.
- **Format drift during transcription.** Reformatting a credential mid-migration (trimming, encoding changes, newline normalization) alters the stored bytes; the keyring stores the new bytes; the upstream service rejects the wrong-format credential.
- **Reader race during atomic-replace.** Writing `tokens.env.new` and renaming over `tokens.env` is atomic at the filesystem level but not at the reader level — a process holding the file open during rename may have inconsistent in-process state.
- **Lost-on-rotation.** A phase that bundles "as part of the migration we'll also rotate the keys" — old key revoked upstream while migration is mid-flight; consumers using the old key start failing before the new key has propagated.
- **Dev environment leakage.** A developer running the migration locally against their own keyring picks up the wrong credentials and pushes a code change with the wrong account name baked in.

### Required preservation guarantees

Non-negotiable. Every PR in this work must satisfy ALL of them:

1. **Every existing credential remains accessible at every phase boundary.** If a request flow that worked at the start of phase X stops working at the start of phase X+1, the migration has failed.
2. **Every phase is revert-safe.** Reverting the merge commit must restore the pre-phase behavior with no manual recovery step. If a revert requires "also delete keyring entries", the phase is unsafe — re-design it.
3. **No deletion of credentials in any committed code, ever.** No `security delete-generic-password`, no `secret-tool clear`, no `unlink(tokens.env)`. The terminal cleanup phase removes STORAGE PATHS (wrapper scripts, `EnvironmentFile=` directives, deploy-script export blocks), not the credential values themselves.
4. **Mirror-not-move when populating a new storage location.** If a phase requires per-instance health tokens to live in the keyring, the migration READS from `tokens.env`, WRITES to the keyring, and leaves `tokens.env` untouched. The `tokens.env` removal is gated to a later, signed-off phase.
5. **Tests do not touch real credential stores.** Vitest mocks for `node:child_process` per the existing pattern at `tests/lib/keyring.test.ts:1-12`. No test ever spawns a real `security` or `secret-tool` invocation against a developer or runtime keyring. The `_resetBackendCache()` test seam exists for this reason — use it.
6. **Idempotent migrations.** If a phase ships a one-shot migration step (copying `tokens.env` contents into the keyring, for example), running it twice must be a no-op or safely converge to the same end state. No "running this twice corrupts X" scripts.
7. **No manual user re-entry of any secret.** The user must never be asked to re-paste an API key as part of recovery. If a migration mishandles a credential, the recovery path must be revert-and-restore-from-snapshot, not "please type the secret again."

### Mechanics of safe migration

For each phase that touches credential flow:

1. **Read-from-both pattern during the transition window.** Phases B, C, and D each leave the runtime in a state where every provider can read the credential from BOTH the new path AND the old path. The fallback is gated by an explicit `allowEnvFallback: true` (or equivalent) flag so a static analysis pass can prove no production code path silently uses the old path.
2. **Mirror, don't move, when populating new storage.** Phase E populates keyring entries from `tokens.env` data via a COPY operation. `tokens.env` is not modified. Removal is a separate, gated, terminal operation in Phase F.
3. **Snapshot before any destructive operation.** Before Phase F removes the wrapper-chain scripts on the runtime host, snapshot the existing launchd plists, deploy script, and wrapper scripts to a timestamped backup directory on the host. Document the restore command in the PR body.
4. **Decommission with explicit signoff and soak time.** Phase F (the only phase that removes credential-adjacent storage) requires:
   - A documented soak period on Phase E (e.g., "the new keyring path has been live for at least 7 days and has served real traffic with no fallback hits").
   - An explicit "approved to remove old path" comment from the user on the PR.
   - A snapshot manifest of the to-be-removed files in the PR description (paths + sizes + sha256).
5. **Account is always explicit.** The new typed lookup API requires the `account` parameter. No call site may rely on `os.userInfo().username` being the right value — pass the per-service account explicitly even when it happens to match the OS user.
6. **Dry-run mode for any migration script.** Any one-shot script (Phase E's keyring-population script, Phase F's wrapper-removal script) MUST have a `--dry-run` mode that prints exactly what it would do without doing it. The PR description must include the dry-run output. The actual run uses `--apply` and is run by the user, not by an agent in CI.

### Verification checkpoints (PR description requirements)

Before merging any phase PR, the description must include:

- **Before-state credential scan.** A read-only command output proving the relevant credentials are accessible via the existing path. From Phase B onward: the same proof for the new path.
- **After-state credential scan.** Same scan run after the change is applied locally, showing identical access.
- **Provider-level smoke test.** One real request per affected provider through the new code path against a non-production endpoint, demonstrating successful authentication.
- **Test-isolation proof.** A `grep` over the new tests for any unmocked spawn of `security`, `secret-tool`, or read of `tokens.env` — must return zero matches outside of mock fixtures.

For Phase F specifically:
- **Snapshot manifest.** Every file slated for removal listed with size and sha256, captured as a backup before any removal.
- **Restore-procedure dry-run.** Verification that the documented restore command in the PR body actually reproduces the pre-removal state when applied to a scratch directory.

### What "non-destructive" means concretely

| Allowed | Forbidden |
|---|---|
| Reading credentials from any storage backend | Deleting credentials from any storage backend |
| Adding new code paths that read credentials | Removing code paths that read credentials, until every consumer has migrated through |
| Writing new keyring entries that mirror existing values | Modifying existing keyring entries' values during a migration |
| Adding new launchd/systemd config alongside existing | Editing existing launchd/systemd in place during a transition phase |
| Snapshotting credential storage before terminal cleanup | Removing snapshots before the cleanup phase has completed its soak |
| Mocked subprocess calls in tests | Real `security` / `secret-tool` invocations against a real keyring in tests |
| Per-phase backups in a documented host location | Reliance on git history alone for credential recovery |

### Recovery if a migration breaks credentials

Triage order for a credentials-broken state:

1. **Stop pushing.** Do not commit any "fix" until the cause is identified.
2. **Confirm the breakage.** Read the credential through the OLD path (the path the previous phase used). If that returns the expected value, the new code is the bug. If the OLD path also returns null, the credential storage itself was modified — escalate to the user immediately.
3. **Revert the merge commit.** `git revert -m 1 <merge-sha>` and push. The revert must restore the previous behavior with no manual data recovery — this is the test for "revert-safe."
4. **If revert alone is insufficient,** restore the credential from the per-phase snapshot. Snapshots live in a documented host location (per the migration script's PR body); never improvise the restore path.
5. **If the snapshot is also corrupt or missing,** STOP. Do not run any further write commands. Coordinate with the user. Manual recovery may require re-entering a secret from a personal secret manager — that is the worst-case path and is the failure mode this entire discipline exists to prevent.

### Anti-patterns to never commit

- Running a migration script that does not have a `--dry-run` mode.
- Scripts that delete credentials before verifying the new path works for every consumer in the runtime.
- Tests that read or write a developer's real keyring or `tokens.env`.
- Code that derives the keyring account from anything other than an explicit parameter.
- Logging that includes credential values, even at debug level, even temporarily during development. Pino structured logs with secret-bearing fields are the most common channel for inadvertent disclosure.
- Bundling a credential-handling change with an unrelated behavior change in the same PR. Credential-storage migrations are isolated PRs.
- Decommission phases that don't reference a soak period or an explicit user-approval comment on the PR.
- Treating `os.userInfo().username` as the keyring account — always pass it explicitly.
- Replacing existing wrapper scripts or deploy paths without a documented restore command in the PR body.

---

## Repo state on entry (what the next agent will land in)

The next agent should expect that local development worktrees may contain unrelated work:

- **Do NOT clean unrelated working-tree state as part of the security work.** Treat unrelated local changes, draft docs, and branch cleanup as separate ownership.
- The companion finding doc lives at `docs/security-handoffs/2026-05-09-env-secret-exposure.md`.
- This kickoff and the finding ship together on branch `docs/security-handoff-env-secrets-20260509`. After that branch merges, fork the implementation work FROM `main` (post-merge), not from the security-handoff branch.
- Do NOT bulk-delete local branches as part of this work. Per the project's branch-deletion discipline, use `git range-diff` and `git cherry -v` per branch before touching any branch that might contain unmerged work or evidence.
- Unrelated protection-layer plans/specs are not in scope here.

**Pre-push hooks are working.** They WILL reject:
- Local absolute paths in committed docs (the public-repo guard).
- Typecheck failures.
- Lint-staged style violations.

Do not disable them. Sanitize content instead.

---

## Existing relevant code (read before changing)

From the finding doc, kept here for the next agent's convenience:

- `src/lib/keyring.ts` — current env-first credential lookup; missing service+account+keychain-path support.
- `src/core/health.ts` — reads `process.env.WHATSOUP_HEALTH_TOKEN` directly.
- `src/runtimes/chat/providers/transcription/openai-whisper.ts` — reads OpenAI credentials from env.
- `src/runtimes/agent/providers/openai-api.ts` — reads and forwards OpenAI credentials to children.
- `src/runtimes/agent/providers/anthropic-api.ts` — reads Anthropic credentials.
- `src/runtimes/agent/session.ts` — `buildChildEnv()` passes OpenAI credentials to CLI-provider children.
- `src/runtimes/chat/providers/pinecone.ts` and `src/mcp/tools/knowledge.ts` — read configured Pinecone env names.
- `src/fleet/routes/ops.ts` — copies a health token from keyring into `tokens.env`.
- `deploy/whatsoup` — can export chat API keys and health token into the Node process env.
- `deploy/whatsoup@.service` — loads `tokens.env` for systemd deployments.
- `with-pinecone-env`, `with-openai-env`, `with-health-token` — the wrapper-chain scripts (NOT in `src/`; they are deployment-side).

---

## Phase plan (each phase ships as a separate PR, mergeable independently)

Each phase ends in a state where the runtime works under both old and new code paths. Roll back by reverting the PR; never by deleting credentials or modifying live keychain state.

### Phase A — Extend keyring.ts with a typed lookup API (no behavior change)

`src/lib/keyring.ts` already exists (~149 lines) and provides `lookupCredential(service, options)` returning `string | null`, with macOS Keychain + secret-tool + env-only backends, user-scoped lookups, and migration fallbacks. **Phase A is additive, not a rewrite.**

Add a new typed function alongside the existing one:

```ts
type LookupRequest = {
  service: string;
  account?: string;          // required for explicit per-instance semantics
  keychainPath?: string;     // dedicated deployment keychain path on macOS
  allowEnvFallback?: boolean; // default false; gated in production by a sentinel
};

export function lookupCredentialTyped(req: LookupRequest): string | null;
// (synchronous to match existing API; an async overload is acceptable if other call sites benefit)
```

What's new vs the existing API:
- **`keychainPath` argument.** macOS `security find-generic-password` accepts a positional keychain-DB argument; the existing code does not pass one. Add it for the dedicated deployment keychain.
- **`allowEnvFallback` toggle.** The existing API is env-first by default; the typed API is keyring-first and requires explicit opt-in for env fallback. A production sentinel (e.g. `WHATSOUP_ENV === 'production'`) forces `allowEnvFallback=false` regardless of caller.
- **Account-required semantics.** The existing API derives the account from `os.userInfo().username` when `options.user` is unset. The typed API makes `account` an explicit parameter so providers can't accidentally lookup as the wrong identity.

Reuse the existing infrastructure:
- `detectKeyringBackend()` (line 37 of keyring.ts) — keep using it.
- `_resetBackendCache()` (line 145) — the test seam.
- `SERVICE_ENV_MAP` (line 15) — extend if new env-name conventions are needed; otherwise reuse.
- The vitest mocking pattern at `tests/lib/keyring.test.ts:1-12` (mocking `node:child_process` for `execFileSync`) is the test-style to follow.

Backends (semantics, unchanged from existing module — just extended):
- **macOS:** invoke `security find-generic-password -s <service> -a <account> -w [<keychain-path>]`. Capture stdout. Redact stderr from any logs the resolver emits. Reads work fine over SSH; do NOT design for keychain writes from the resolver — the rotation lane handles writes via a separate path.
- **Linux:** invoke `secret-tool lookup service <service> account <account>`.
- **Env fallback:** only when `allowEnvFallback: true` AND the production sentinel is not set.

Tests:
- Unit tests in `tests/lib/keyring.test.ts` for each backend's argv shape, including the new `keychainPath` positional arg.
- Negative tests: env fallback disabled by default; explicit-allow path required; production sentinel overrides the toggle.
- A static guard added to `scripts/repo-hygiene-guard.ts` that fails if any non-test, non-keyring-module code path reads a known-secret env name directly. Allowlist exactly the provider/test/dev call sites that exist BEFORE Phase B starts; later phases tighten the allowlist.

NOT in this PR:
- No provider code changes.
- No launchd/systemd changes.
- No removal of the existing `lookupCredential(service, options)` API — it stays in place; the new typed function lives alongside.

**Acceptance for Phase A:** new typed function exists with tests; no provider consumes it yet; production runtime behavior unchanged; `npm run typecheck:all` green; `npm run guard:repo` green; vitest suite green (run with `--pool=forks` per repo convention).

### Phase B — Provider boundary migration (one provider per PR)

For each of: OpenAI, Anthropic, Whisper, Pinecone, Knowledge MCP, ElevenLabs, health auth — separate PR each:

- Add a resolver call at module load (or first-use), with the existing env-var read kept as the explicit `allowEnvFallback: true` fallback.
- Provider tests use a mocked resolver; existing env-based tests still pass.
- Live runtime continues to receive secrets via the wrapper chain — the resolver is consulted but env still wins until Phase C inverts the precedence.

**Acceptance per provider PR:** provider's secret reads route through the resolver; tests pass; production runtime sees no behavior change because env is still authoritative.

### Phase C — Reverse the precedence (resolver-first, env-fallback)

A single PR that flips the resolver-vs-env precedence in each provider so the resolver is consulted first and env is the degraded-mode fallback. After this PR, keychain reads are the hot path.

**Acceptance:** after a freshly-restarted parent process on a runtime host where the wrapper chain is still in place, the resolver is the source of truth. Reverting this PR returns to env-first without other changes.

### Phase D — Stop child env inheritance

Modify `buildChildEnv()` so it explicitly excludes the named API keys when spawning agent children. CLI providers that previously relied on inherited env keys (Claude/Codex/OpenCode/Gemini children) must use their native auth or be rejected for env-key-only modes.

**Acceptance:** child agent processes' `ps eww` shows no inherited API key env names. Existing parent functionality unchanged.

### Phase E — Health token migration

Stop writing/reading `tokens.env`. Store per-instance health tokens as keyring entries (`service=whatsoup_health`, `account=<instance>`). Fleet ops/discovery resolves by instance name through the resolver.

**Acceptance:** generated configs and launchd/systemd units no longer reference `tokens.env`. Health endpoint still serves correct tokens. Existing tokens migrated, not regenerated.

### Phase F — Wrapper-chain removal (deploy cleanup, terminal phase)

The terminal phase. Update launchd plist generation and `deploy/whatsoup` to invoke node directly with non-secret `HOME`/`PATH` only. Remove `with-pinecone-env`, `with-openai-env`, `with-health-token` from `ProgramArguments`. Remove `EnvironmentFile=…/tokens.env` from systemd units.

Live-deploy this on the runtime host as the final commit and run the acceptance scan in the next section.

---

## Acceptance criteria (final, run on the runtime host after Phase F)

1. `ps eww` over every WhatSoup parent and child PID returns NO occurrence of `OPENAI_API_KEY=`, `ANTHROPIC_API_KEY=`, `PINECONE_API_KEY=`, `ELEVENLABS_API_KEY=`, or `WHATSOUP_HEALTH_TOKEN=` in any process environment.
2. Static guard (added in Phase A) fails CI if any non-test, non-resolver code path reads `process.env.<one of the named keys>` directly.
3. Generated launchd plists and systemd units contain no secret env files and no secret-injecting wrapper chain.
4. Live runtime functionality unchanged: chat completions, transcription, knowledge MCP, fleet health endpoints all return their expected results within their existing latency budgets.
5. Rotation: changing the relevant keychain entry and signaling the runtime causes new requests to succeed without a parent-process restart, OR the explicit restart requirement is documented in the PR body and reflected in the rotation runbook.

---

## Anti-patterns to avoid

- **Don't delete keychain entries during the migration.** The wrapper chain must keep working until Phase F. Deleting the keychain entries before Phase F bricks the runtime.
- **Don't try to write to a dedicated deployment keychain over SSH from a Node process.** macOS keychain writes from non-GUI sessions may require user interaction. The resolver is read-only by design; secret rotation belongs in a separate operator path.
- **Don't ship a phase that requires a manual runtime restart without flagging it explicitly** in the PR body. The migration should be hot-deployable per-process; if a phase requires a runtime restart, coordinate with the user.
- **Don't pull or reconcile a runtime host's checkout silently.** Coordinate deployment-state changes with the user; understand which security PRs are deployed before pulling more in.
- **Don't bulk-delete stale local branches** without per-branch evidence. Some may carry uncommitted work or recovery artifacts.
- **Don't disable the public-repo pre-push guard** to ship docs containing absolute user paths or internal hostnames — sanitize the doc instead. The guard exists for this exact reason.
- **Don't co-author commits as Claude or any model.** Per repo hygiene: no co-author trailers, no model names, no internal labels in commit messages or PR bodies.
- **Don't open GitHub issues without explicit user approval.** This handoff lives as a doc, not as an issue.

---

## Coordination touchpoints

After each phase merges:
- Update the Status Table (W-1..W-6) in `2026-05-09-env-secret-exposure.md` with the merged SHA and date.
- Append a one-line changelog at the bottom of THIS doc with PR number, merged SHA, and phase letter.

After Phase F (final merge):
- Run the acceptance scan on the runtime host.
- The runtime host's WhatSoup checkout reconciliation (currently behind upstream) becomes the natural unblock — coordinate with the user.
- Mark the original finding doc with a "RESOLVED" header pointing at the final merged SHA.
- Deployment-specific host-context tracking is handled outside this public repository.

---

## Out of scope

- Host posture, network posture, desktop integration, container posture, and reboot-survival work. Different lane.
- Unrelated local service gates, sidecars, and reverse-proxy posture. Different lane.
- WhatSoup branch drift and local worktree cleanup. Separate technical-debt workstream.
- The large untracked protection-layer plan/spec docs. Different feature, different agent.
- GitHub issue filing. Explicit user approval required by repo hygiene rules.

If the next agent finds itself drifting into any of these, stop and ask the user. Cross-cutting work blurs the seams that this handoff spent effort to keep clean.

---

## Reference Index

A grab-bag of pointers the next agent should have on hand. Treat this as a starting bibliography, not an exhaustive list.

### Relevant skills available in the agent environment

These skills exist in the agent runtime and reduce the cost of doing each phase well. Invoke them via the Skill tool when the trigger fits.

| Skill | When to use it |
|---|---|
| `superpowers:brainstorming` | Before Phase A's typed-API design — sketch the LookupRequest shape and account semantics with a quick brainstorm pass. |
| `superpowers:writing-plans` | If you need to expand any single phase into its own implementation plan with checkpoints. |
| `superpowers:test-driven-development` | Phase A's resolver tests; Phase B's per-provider provider tests. |
| `superpowers:executing-plans` | Running this kickoff's phase plan in a separate session with review checkpoints. |
| `superpowers:subagent-driven-development` | Phase B is naturally per-provider parallel; dispatch one subagent per provider for the resolver wiring. |
| `superpowers:dispatching-parallel-agents` | Same shape as above when 2+ providers can be migrated in parallel without shared state. |
| `superpowers:requesting-code-review` | Mandatory between phases; each phase PR should get a fresh reviewer. |
| `superpowers:verification-before-completion` | Load-bearing — every "fixed" claim needs `ps eww` evidence on the runtime host. Never claim a phase is done without running the verification command in the same message. |
| `superpowers:systematic-debugging` | If any phase exposes unexpected runtime behavior, before proposing fixes. |
| `superpowers:finishing-a-development-branch` | Each phase ends in a PR; this skill guides the merge/cleanup options. |
| `superpowers:receiving-code-review` | When the reviewer pushes back; technical rigor over performative agreement. |
| `commit-commands:commit-push-pr` | The standard commit + push + PR workflow for each phase. |
| `feature-dev:feature-dev` | Full feature lifecycle including architect → review → test passes. |
| `feature-dev:code-explorer` (agent) | Pre-Phase B — trace every consumer of the secret env names and the wrapper-chain invocation graph end-to-end before committing the migration order. |
| `feature-dev:code-architect` (agent) | If the typed-resolver API design has architectural ambiguity (e.g., should it be async? should there be a per-instance cache?). |
| `feature-dev:code-reviewer` (agent) | At each phase PR; the agent can also audit the migration for symmetry gaps (the recurring failure mode from the originating session). |
| `claude-project-context` | Load WhatSoup project context fresh on session entry. |
| `pinecone:*` | Phase B Pinecone provider migration; query Pinecone docs before changing the API key handling. |
| `test-integrity:*` | After writing new tests, scan them for assertion-free / mocked-only / vacuous patterns. |
| `episodic-memory:remembering-conversations` | If you need history on how prior keyring/auth decisions were made. |
| `codex-memory` | Cross-session recall — this finding originated from a peer-agent probe. |
| `claude-api` | Not relevant unless directly calling the Anthropic SDK; provider migration uses subprocess CLI auth, not SDK calls. |

### File paths with concrete line numbers

Direct env reads to migrate (Phase B targets — confirmed by grep at handoff time):

| File | Line(s) | Pattern |
|---|---|---|
| `src/core/health.ts` | 92 | reads `WHATSOUP_HEALTH_TOKEN` directly from process env |
| `src/runtimes/chat/providers/transcription/openai-whisper.ts` | 22, 71 | reads `OPENAI_API_KEY` (existence check + isAvailable) |
| `src/runtimes/agent/providers/openai-api.ts` | 105, 228, 229, 251 | apiKey field set from env; child env passthrough; Bearer header |
| `src/runtimes/agent/providers/anthropic-api.ts` | 106, 231, 232, 258 | apiKey field set from env; child env passthrough; x-api-key header |
| `src/runtimes/chat/providers/pinecone.ts` | 108, 363 | reads from env via `configuredPineconeApiKeyEnv()` indirection |
| `src/mcp/tools/knowledge.ts` | 185 | reads from env via `memoryConfig.apiKeyEnv` indirection |
| `src/runtimes/agent/session.ts` | 88–115 | `buildChildEnv(provider)` switch — already provider-specific; convert to resolver lookups, don't widen it |
| `src/runtimes/agent/session.ts` | 706, 1240 | `buildChildEnv()` call sites |
| `src/runtimes/agent/providers/claude.ts` | 16, 83, 223 | imports + uses `buildChildEnv` for the Claude CLI child |
| `src/fleet/discovery.ts` | 98, 100, 104, 110 | reads `tokens.env` and parses `WHATSOUP_HEALTH_TOKEN=...` (Phase E target) |
| `src/fleet/routes/ops.ts` | 949 | writes `tokens.env` with the health token line (Phase E target) |
| `deploy/whatsoup` | 87, 88, 102, 103, 105, 111–113, 119–121, 126 | shell helper exports OPENAI/PINECONE/ANTHROPIC into env before invoking node (Phase F target on systemd) |
| `deploy/whatsoup@.service` | 30 | `EnvironmentFile=-…/tokens.env` (Phase E + F target) |
| `deploy/generate-health-tokens.sh` | 22, 59, 72 | writes/reads `WHATSOUP_HEALTH_TOKEN=...` to per-instance `tokens.env` (Phase E target) |

Existing infrastructure to reuse (don't reinvent):

| File | Line(s) | What's there |
|---|---|---|
| `src/lib/keyring.ts` | 15–22 | `SERVICE_ENV_MAP` — env-name lookup table; extend if needed |
| `src/lib/keyring.ts` | 24–26 | `SERVICE_MIGRATION_FALLBACKS` — keyring service-name aliases |
| `src/lib/keyring.ts` | 28–32 | `CredentialLookupOptions` interface — extend or define a sibling typed interface |
| `src/lib/keyring.ts` | 37–55 | `detectKeyringBackend()` — backend detection with caching |
| `src/lib/keyring.ts` | 70 | `lookupCredential(service, options)` — existing API; keep, don't break |
| `src/lib/keyring.ts` | 145–148 | `_resetBackendCache()` — test-only seam |
| `tests/lib/keyring.test.ts` | 1–12 | vitest mocking pattern for `node:child_process` (mocks `execFileSync`) |
| `tests/lib/health-token-keyring.test.ts` | — | second example of the same test pattern |
| `scripts/repo-hygiene-guard.ts` | — | existing pre-commit hygiene guard; add the static "no direct process-env-secret reads outside allowlist" rule here |
| `scripts/pre-push-guard.ts` | — | pre-push test runner; the resolver tests will run through this |
| `src/utils/execFileNoThrow.ts` | — | repo's safe-spawn wrapper — prefer this in any new resolver code over raw spawn calls |

### Repo-internal documentation pointers

Read for context before designing:

- `CLAUDE.md` — project overview, architecture, key files index, conventions (ESM, Zod, Pino, vitest --pool=forks)
- `docs/configuration.md` — environment variables, instance.json schema, XDG paths, per-instance plugin scoping
- `docs/runbook.md` — operational runbook (service management, troubleshooting, recovery — relevant for Phase F deploy changes)
- `docs/durability.md` — durability engine design (relevant to "non-destructive" constraint)
- `docs/tools.md` — MCP tool API reference (relevant for `src/mcp/tools/knowledge.ts` change)

### External documentation

For the macOS backend:
- macOS `security` man page — `man 1 security` (locally) or Apple Open Source `security_tool` reference. Note: `find-generic-password -w` reads work fine in non-GUI sessions; writes do NOT (verified separately).
- Apple Security framework / Keychain Services reference at `developer.apple.com/documentation/security/keychain_services` for the underlying API the CLI wraps.

For the Linux backend:
- `secret-tool` man page — `man 1 secret-tool` (locally).
- libsecret / Secret Service API at `gnome.pages.gitlab.gnome.org/libsecret/` for the underlying D-Bus protocol; useful if `secret-tool` exit codes need disambiguation.
- freedesktop.org Secret Service spec at `specifications.freedesktop.org/secret-service/` for the protocol-level semantics.

For Node.js subprocess hygiene:
- Node subprocess module reference under `nodejs.org/api/` — pay attention to argv escaping semantics. The repo's `src/utils/execFileNoThrow.ts` wrapper is the preferred call site for any new spawn from this work; it uses the file-with-args invocation form (not the shell-string form), so command injection is impossible by construction.
- TypeScript types: `NodeJS.ProcessEnv`, subprocess spawn-options types — relevant to the Phase D `buildChildEnv` refactor.

### Repo conventions to honor

From `CLAUDE.md`:
- ESM throughout, no CommonJS.
- Zod for runtime validation (use it for `LookupRequest` validation if input ever crosses a boundary).
- Pino for structured logging (the resolver should not log secret values; if you log a failure, log only the service+account+platform, never the value).
- Real SQLite in tests; vitest with `--pool=forks` for stability.
- Tests mirror source structure under `tests/`.
- Node >= 23.10, native strip-types, no build step.

### npm scripts you'll run frequently

| Command | What it does |
|---|---|
| `npm run typecheck:all` | TypeScript check — must pass before push |
| `npm run guard:repo` | Repo hygiene scan (catches absolute paths, etc.) |
| `npm run guard:repo:staged` | Same scan against the git index — pre-commit hook calls this |
| `npm run guard:pre-push` | Pre-push verification (16 tests at handoff time) |
| `npm test` | Run the test suite |
| `npx vitest run --pool=forks` | Stability-first test invocation per repo convention |
| `npm run test:watch` | Vitest in watch mode for TDD on Phase A |

### Out-of-scope cross-references (DO NOT touch)

- Companion deployment-context tracker (full routing detail, full paths) — maintained outside this public repository.
- Operator-side rotation handoff — separate deployment-operations repository.
- Originating audit trail — outside this public repository.
- Network-policy redesign — separate fleet-policy project.
- Host posture residuals — outside this public repository.

If you find yourself reading these to inform an editing decision in WhatSoup, you're past the boundary. Stop and ask the user.

---

## Changelog

(Append one line per merged phase PR.)

- 2026-05-09 — kickoff doc + finding doc on branch `docs/security-handoff-env-secrets-20260509`; PR not yet opened.
- 2026-05-10 — kickoff + finding docs merged via PR #199 at SHA `9493012c`.
- 2026-05-12 — Phase B (partial: OpenAI + Anthropic agent providers honor `apiKeyService`) merged via PR #370 at SHA `a4bcb536`. Remaining Phase B providers (Whisper, Pinecone, Knowledge MCP, ElevenLabs, health auth) still pending. Phase A typed-API not yet shipped — PR #370 used the existing `lookupCredential` shim.
