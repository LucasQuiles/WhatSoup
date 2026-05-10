# WhatSoup Env-Secret Exposure — Implementation Kickoff

**Companion to:** [`2026-05-09-env-secret-exposure.md`](2026-05-09-env-secret-exposure.md) (the finding)
**Status:** OPEN — awaiting implementation
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

## Repo state on entry (what the next agent will land in)

The next agent should expect a non-pristine working tree on `LucasQuiles/WhatSoup`:

- `main` was **42 ahead, 174 behind origin/main** at handoff time, with dirty `.gitignore` and `CLAUDE.md` and several untracked docs. **Do NOT clean this up as part of the security work** — it is pre-existing technical debt with separate ownership and a separate cleanup workstream.
- The companion finding doc lives at `docs/security-handoffs/2026-05-09-env-secret-exposure.md`.
- This kickoff and the finding ship together on branch `docs/security-handoff-env-secrets-20260509`. After that branch merges, fork the implementation work FROM `main` (post-merge), not from the security-handoff branch.
- **42 local branches have upstream gone.** Do NOT bulk-delete; some may carry uncommitted work or evidence relevant to a separate workstream. Per the project's branch-deletion discipline, use `git range-diff` and `git cherry -v` per branch before touching any.
- A large untracked `docs/plans/2026-05-08-whatsoup-protection-layer-implementation-plan.md` exists locally and is not in scope here.
- `docs/specs/2026-05-08-whatsoup-protection-layer-design.md` is untracked locally but tracked upstream and differs by one event-list line — not in scope here.

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

### Phase A — Add typed credential resolver (no behavior change)

Create `src/lib/credentials/resolver.ts` (or equivalent module location matching repo conventions) implementing:

```ts
type LookupRequest = {
  service: string;
  account?: string;          // required for keychain semantics on both platforms
  keychainPath?: string;     // dedicated mwlab keychain path on macOS
  allowEnvFallback?: boolean; // default false
};

async function lookupCredential(req: LookupRequest): Promise<string>;
```

Backends:
- **macOS:** spawn `security find-generic-password -s <service> -a <account> -w [<keychain-path>]`. Capture stdout. Redact stderr from any logs the resolver emits. Reads work fine over SSH; do NOT design for keychain writes from the resolver — the rotation lane handles writes via a separate path.
- **Linux:** spawn `secret-tool lookup service <service> account <account>`.
- **Env fallback:** ONLY when `allowEnvFallback: true` AND a `WHATSOUP_ENV != production` (or equivalent) sentinel. Used by tests and dev only.

Tests:
- Unit tests for each backend's argv shape.
- Negative tests: env fallback disabled by default; explicit-allow path required.
- A static guard test that fails if any non-test, non-resolver code path reads a known-secret env name directly. Allowlist provider/test/dev call sites.

NOT in this PR:
- No provider code changes.
- No launchd/systemd changes.
- The old `lookupCredential(service: string)` helper stays in place; the new typed API lives alongside it during migration.

**Acceptance for Phase A:** new module exists with tests; no provider consumes it yet; production runtime behavior unchanged; build green; existing typecheck and lint hooks pass.

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
- **Don't try to write to a dedicated mwlab keychain over SSH from a Node process.** Verified failure: macOS keychain writes from a non-GUI session return "User interaction is not allowed". The resolver is read-only by design; secret rotation lives in a separate operator script (already addressed by the operations-side handoff in the machine-config repo).
- **Don't ship a phase that requires a manual mwlab restart without flagging it explicitly** in the PR body. The migration should be hot-deployable per-process; if a phase requires a runtime restart, coordinate with the user.
- **Don't pull the runtime host's WhatSoup checkout silently.** It was 108+ commits behind origin/main at handoff time. Coordinate the pull with the user; understand which security PRs are deployed before pulling more in.
- **Don't bulk-delete the 42 stale local branches** without per-branch evidence. Some may carry uncommitted work or recovery artifacts.
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
- A separate, private host-context tracker exists for this work; the user owns updating it.

---

## Out of scope

- Host posture: firewall, sshd, Tailscale ACL, FileVault, AirPlay/Continuity, Docker. Different lane.
- Ollama bearer-token gate: rotation, sidecar, Caddy. Different lane (machine-config).
- WhatSoup `main`-branch drift cleanup (42 ahead / 174 behind). Separate technical-debt workstream.
- The large untracked protection-layer plan/spec docs. Different feature, different agent.
- GitHub issue filing. Explicit user approval required by repo hygiene rules.

If the next agent finds itself drifting into any of these, stop and ask the user. Cross-cutting work blurs the seams that this handoff spent effort to keep clean.

---

## Changelog

(Append one line per merged phase PR.)

- 2026-05-09 — kickoff doc + finding doc on branch `docs/security-handoff-env-secrets-20260509`; PR not yet opened.
