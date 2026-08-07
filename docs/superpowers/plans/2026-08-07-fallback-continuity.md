# Fallback Continuity and Headless Provider Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fallback turns survive a macOS headless OpenCode launcher, preserve user context once and in order, and prove the full provider-to-WhatsApp delivery path before reporting replay success.

**Architecture:** Harden the provider stream boundary with an exact first-record normalizer, add a real headless provider canary to the fleet health surface, and assemble fresh-session application context chronologically without duplicating the active turn. Deploy the minimal recoverable host repair only after repository behavior is pinned by tests, then replay and verify using durable inbound, provider-session, outbound-operation, and WhatsApp echo evidence.

**Tech Stack:** TypeScript, Vitest, Python 3 health checker, SQLite operational evidence, zsh/launchd, OpenCode JSONL, WhatsApp/WhatSoup fleet tooling.

## Global Constraints

- Preserve arbitrary malformed JSONL as `parse_error`; normalize only the exact observed `^D\b\b` prefix on the first JSON record and the closed OpenCode diagnostic grammar at the PTY boundary.
- Never print, commit, or copy credential values into logs or documentation.
- Preserve the primary main worktree and its untracked `LEDGER.md`; all repository edits stay in the isolated worktree.
- Use the SSH Git remote `git@github.com:LucasQuiles/WhatSoup.git` for promotion.
- Do not report replay success until both provider terminal completion and terminal WhatsApp echo/delivery are observed.
- Masked or interrupted tests are inconclusive, not passing evidence.

---

### Task 1: Normalize the observed first OpenCode JSONL record

**Files:**
- Modify: `tests/runtimes/agent/providers/opencode-parser.test.ts`
- Modify: `src/runtimes/agent/providers/opencode-parser.ts`

**Interfaces:**
- Consumes: `createOpenCodeParser(): OpenCodeParser`
- Produces: unchanged `OpenCodeParser.parse(line): AgentEvent | null` with exact first-record startup normalization

- [x] **Step 1: Write failing parser tests**

Add tests proving `^D\b\b{...step_start...}` emits `init` only on the first non-blank record, reset restores that allowance, and the same prefix on a later record remains `parse_error`.

- [x] **Step 2: Run the parser test and verify RED**

Run: `npm test -- tests/runtimes/agent/providers/opencode-parser.test.ts --pool=forks --fileParallelism=false --retry=0`

Expected: the startup-artifact tests fail because `JSON.parse` receives the prefix.

- [x] **Step 3: Implement the minimal parser normalization**

Track whether the parser has consumed its first non-blank record. Before the first parse only, replace `/^\^D\x08\x08(?=\{)/` with an empty string. Mark the first record consumed regardless of parse success, and reset both parser state flags in `reset()`.

- [x] **Step 4: Run focused parser suites and verify GREEN**

Run:

```bash
npm test -- tests/runtimes/agent/providers/opencode-parser.test.ts tests/runtimes/agent/providers/stream-parsers.test.ts tests/runtimes/agent/providers/parser-interface-conformance.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: all selected tests pass with no masked failures.

- [x] **Step 5: Commit**

```bash
git add src/runtimes/agent/providers/opencode-parser.ts tests/runtimes/agent/providers/opencode-parser.test.ts
git commit -m "fix(agent): normalize OpenCode headless startup record"
```

### Task 2: Add a strict functional OpenCode fallback canary

**Files:**
- Modify: `deploy/scripts/bot-errors-health-check.py`
- Modify: `tests/scripts/bot-errors-health-check.test.ts`
- Modify as required by the existing profile schema: `deploy/health-profiles/*.json`

**Interfaces:**
- Consumes: `opencode_provider_probe_inventory(...) -> list[str]`, existing dry-run provider probe environment
- Produces: structural JSONL validation requiring `step_start` and terminal `step_finish(reason=stop)` for opt-in modern-run probes

- [x] **Step 1: Write failing health-check fixtures**

Add hermetic cases for valid terminal JSONL, `^D\b\b`-corrupted first JSONL, valid but non-terminal JSONL, and a bounded timeout. Assert distinct failure classes and confirm evidence contains no prompt or credential value.

- [x] **Step 2: Run the selected health-check cases and verify RED**

Run: `npm test -- tests/scripts/bot-errors-health-check.test.ts -t "OpenCode fallback provider probe" --pool=forks --fileParallelism=false --retry=0`

Expected: functional-probe assertions fail because current inventory only checks version/help and credential presence.

- [x] **Step 3: Implement the bounded functional probe**

Add a validator that accepts only the closed OpenCode diagnostic grammar outside JSONL, parses every remaining non-blank stdout line, rejects malformed records, requires `step_start`, and requires `step_finish` with `part.reason == "stop"`. Invoke the exact configured production command as `run --format json --pure --print-logs --log-level INFO -m <model>` and pass the bounded prompt on non-TTY stdin only when the profile opts into the functional canary; reuse the bounded process helper and deterministic dry-run inputs.

- [x] **Step 4: Enable the canary in the relevant fleet profile defaults**

Add the smallest profile flag needed for agent instances with OpenCode fallback. Keep hosts without the supported modern-run contract explicitly skipped rather than silently passed.

- [x] **Step 5: Run focused health and profile tests and verify GREEN**

Run:

```bash
npm test -- tests/scripts/bot-errors-health-check.test.ts tests/deploy/credential-probe-boundedness.test.ts --pool=forks --fileParallelism=false --retry=0
npm run guard:bot-errors-runtime-manifest
```

Expected: all selected tests and the manifest guard pass.

- [x] **Step 6: Commit**

```bash
git add deploy/scripts/bot-errors-health-check.py deploy/health-profiles tests/scripts/bot-errors-health-check.test.ts
git commit -m "fix(health): prove headless OpenCode fallback turns"
```

### Task 3: Preserve chronological, non-duplicated fresh-session context

**Files:**
- Modify: `tests/runtimes/agent/runtime-secondhalf-branches.test.ts`
- Modify: `src/runtimes/agent/runtime.ts`

**Interfaces:**
- Consumes: `getRecentMessages(...): StoredMessage[]` in chronological ascending order and the accepted `userTurnText`
- Produces: application context in chronological order with the active inbound request omitted when it is the newest matching inbound record

- [x] **Step 1: Write failing runtime tests**

Return realistic chronological rows from the `getRecentMessages` mock. Assert the formatted context places the earlier message before the later one and excludes a newest inbound row whose sender/content identify the explicit `userText`.

- [x] **Step 2: Run the runtime case and verify RED**

Run: `npm test -- tests/runtimes/agent/runtime-secondhalf-branches.test.ts -t "fresh-spawn context preamble" --pool=forks --fileParallelism=false --retry=0`

Expected: order and active-turn de-duplication assertions fail under `recent.reverse()` and unfiltered history.

- [x] **Step 3: Implement minimal context preparation**

Remove the reverse operation because `getRecentMessages` already returns ascending rows. Filter only the newest matching inbound record for the active sender/content; do not globally deduplicate repeated historical messages. Reuse the resulting helper in resume-failure context recovery where the active turn is known.

- [x] **Step 4: Run runtime continuity suites and verify GREEN**

Run:

```bash
npm test -- tests/runtimes/agent/runtime-secondhalf-branches.test.ts tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/handoff-distill-coordinator.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: selected suites pass with chronological, single-occurrence context.

- [x] **Step 5: Commit**

```bash
git add src/runtimes/agent/runtime.ts tests/runtimes/agent/runtime-secondhalf-branches.test.ts
git commit -m "fix(agent): preserve fallback context continuity"
```

### Task 4: Verify, deploy the host repair, replay, and promote

**Files:**
- Modify if required by verification: files already owned by Tasks 1-3
- Create outside Git: a private host operation receipt under the existing WhatSoup state/operation-record convention

**Interfaces:**
- Consumes: focused passing commits, `wa-fleet.sh`, target launchd configuration and SQLite evidence
- Produces: verified provider canary, terminal admin replay evidence, pushed branch and repository promotion receipt

Before live replay, reproduce a tool-using turn with the exact production logging flags. PTY-merged diagnostic lines must advance watchdog liveness and must not enter the JSON parser; unknown non-JSON output remains fatal.

- [x] **Step 1: Run repository verification**

Run:

```bash
npm run typecheck
npm run typecheck:scripts
npm run guard:repo:branch-diff
npm run guard:publication:release
npm run verify:push:branch
```

Expected: every command passes. If a gate fails for an unrelated baseline condition, retain the exact failure and do not call it clean.

- [x] **Step 2: Review the branch**

Run `git diff --check`, inspect `git diff origin/main...HEAD`, inspect `git log --oneline origin/main..HEAD`, and verify no secrets, host-private identifiers, forbidden attribution, or unrelated files are present.

- [x] **Step 3: Install a recoverable host repair**

Resolve the live wrapper and service paths read-only, create a timestamped backup, install the minimal exact-prefix scrub or deploy the parser fix, retain permissions, and record before/after hashes without credential content.

- [x] **Step 4: Validate all execution surfaces**

Run the same bounded OpenCode JSONL canary through non-interactive SSH, a launchd-like minimal environment matching the target instance, and an interactive PTY. Require valid records and terminal `step_finish(reason=stop)` on each available surface.

- [x] **Step 5: Replay through the proven inbound identity**

Resolve the admin-side sending instance or recovery injection surface, dry-run the exact destination and text `1`, confirm the authorized replay, and record the new agent inbound sequence. Never send `1` from the agent line to the admin because that reverses the request direction.

- [x] **Step 6: Monitor terminal answer and delivery**

Observe fallback selection, provider terminal result, complete persisted outbound response, and terminal echo/delivery for every response operation. Compare the answer to the request represented by option `1`; if it only asks another question or restarts without completion, keep the replay open.

- [x] **Step 7: Commit final documentation adjustments and push**

Run the relevant focused verification again, commit any reviewed documentation/profile receipts that are safe for the public repository, then push with `git push -u origin fix/fallback-continuity` over SSH.

- [ ] **Step 8: Promote through the repository workflow**

Use the repository's required PR/merge path, preserving guard results and rollback notes. Do not bypass branch protection. Verify the resulting remote ref and deployed host commit separately before reporting platform promotion complete.

### Task 5: Remove operational chat content from OpenCode argv

**Files:**
- Modify: `tests/runtimes/agent/session.test.ts`
- Modify: `src/runtimes/agent/session.ts`
- Modify: `docs/configuration.md`
- Modify: `deploy/source-runtime-manifest.json`

Live process inspection during the replay showed that the complete operational
prompt was present in the `opencode run` argument vector. OpenCode's run command
accepts its message from non-TTY stdin, so the portable runtime should use that
transport for real turns while leaving stdout/stderr JSONL handling unchanged.

- [x] **Step 1: Add a failing argv-privacy regression test**

Assert that application context and the user message are absent from spawned
OpenCode arguments and are written, in order, to the child's stdin. The test
failed against the argv transport before implementation.

- [x] **Step 2: Move operational turn input to stdin**

Build OpenCode argv from structural flags only. Write the composed turn once to
stdin and close it immediately so the non-interactive command receives EOF.

- [x] **Step 3: Verify locally and on the deployed LaunchAgent**

Run the full session and OpenCode execution-profile suites, both TypeScript
checks, the source-runtime manifest guard, and one live fallback replay. During
the live turn, inspect only process metadata and prove the user text is absent
from argv without printing the remaining arguments.

- [x] **Step 4: Commit, push, and include in repository promotion**

Commit the reviewed privacy hardening, rerun the branch push gate, deploy the
exact pushed commit, and retain the live terminal delivery proof in the private
operation receipt.

### Task 6: Bind headless stdin and live-turn delivery to one authority

**Files:**
- Modify: `deploy/scripts/bot-errors-health-check.py`
- Modify: `src/core/provider-mcp-config.ts`
- Modify: `src/runtimes/agent/session.ts`
- Modify: focused tests and operator documentation

The first post-deploy canary proved the runtime prompt was absent from argv but
failed because a PATH-shadowing wrapper allocated a PTY and discarded stdin.
After the wrapper was repaired, the fallback completed but also invoked
`send_message`, creating a second same-turn outbound message beside the normal
terminal echo.

- [x] **Step 1: Reproduce both failures with bounded evidence**

Record only structural process facts, JSONL record types, terminal rows, tool
outcomes, and outbound-operation identities. Do not retain prompt argv or
credential content.

- [x] **Step 2: Make the functional probe exercise stdin**

Remove the positional canary prompt, pass it through `subprocess.run(input=...)`,
and assert the prompt is absent from the command vector. This makes wrapper/PATH
drift fail before fallback traffic is admitted.

- [x] **Step 3: Give live-turn text one delivery owner**

Preserve existing OpenCode permissions but force the exact
`whatsoup_send_message` tool to `deny`; add direct live-turn prompt guidance and
tests for absent, scalar, sibling, and stale-allow permission shapes.

- [x] **Step 4: Deploy and prove a single terminal response**

Deploy the exact pushed ref, regenerate the instance OpenCode configuration,
and run one final fallback canary. Require prompt absence from argv, one terminal
echo, no same-turn non-terminal text send, and a complete inbound disposition.

- [ ] **Step 5: Commit, push, and promote**

Update the source-runtime manifest and work index, run the required branch gate,
push over SSH, and include the live proof and rollback path in repository
promotion.

### Task 7: Close independent-review canary and permission gaps

**Files:**
- Modify: `deploy/scripts/bot-errors-health-check.py`
- Modify: `deploy/scripts/install-bot-errors-{,health-}launchd.sh`
- Modify: `src/core/provider-mcp-config.ts`
- Modify: `src/runtimes/agent/session.ts`
- Modify: focused tests and runtime manifests

Two independent reviews found that the first functional probe could accept any
non-empty text in any record order, used a fallback-only config surface the
runtime does not consume, inherited the monitor's entire environment, and
relied on a global permission that an agent-specific rule can override.

- [x] **Step 1: Prove the gaps with failing tests**

Add RED cases for wrong canary text, terminal-not-last streams, inherited
fallback execution settings, positive credential allowlisting, explicit
launchd provider paths, and selected-agent permission precedence.

- [x] **Step 2: Make the functional probe runtime-faithful and fail-closed**

Require an ordered exact `OK` turn, derive fallback settings from the primary
provider config while excluding endpoint fields, include `--agent` and
`--auto`, and pass only system essentials plus the selected credential.

- [x] **Step 3: Align launchd path and delivery authority**

Render an explicit provider PATH for the health LaunchAgents, add standard
Homebrew discovery only after configured/PATH candidates, enforce the exact
send deny on both global and selected-agent layers, and remove the impossible
OpenCode late-send prompt instruction.

- [ ] **Step 4: Re-review, push exact SHA, and promote**

Regenerate manifests, run integrity/focused/type/release gates under the pinned
Node runtime, obtain independent approval and CI for the exact pushed SHA, then
merge without bypassing repository protections.

### Task 8: Close runtime-context parity gaps

**Files:**
- Modify: `deploy/scripts/bot-errors-health-check.py`
- Modify: `docs/configuration.md`
- Modify: focused tests and runtime manifest

The second review found that the health process could still select a provider
binary, credential source, environment, or working directory that differed
from the instance process it was meant to validate.

- [x] **Step 1: Reproduce registry, auth-store, PATH, cwd, and environment drift**

Add RED coverage for the full runtime credential registry, OpenCode's terminal
auth store, PATH collisions, the generated instance LaunchAgent PATH, the
configured workspace, and every compatibility/functional child environment.

- [x] **Step 2: Execute every OpenCode probe in the runtime context**

Resolve the binary only through the instance PATH, use the configured/default
agent cwd as cwd, pass one positive environment allowlist to version,
help, and functional calls, and project only the selected provider credential.

- [x] **Step 3: Match credential resolution and private-file constraints**

Keep the health credential registry identical to the runtime registry, include
the OpenCode auth store as the terminal fallback, and read WhatSoup key files
as bounded, current-user, private regular files without following symlinks.

- [ ] **Step 4: Re-review, publish, deploy, and prove exact-head parity**

Run the full gates, obtain fresh independent review of the exact local head,
push over SSH, observe CI and required approval, then deploy that exact head and
capture loaded PATH, workspace/config, credential-source, canary, health, and
single-message proof on the target host.

### Task 9: Close loaded-job and modern-chain review gaps

- [x] Compare the generated LaunchAgent PATH with the currently loaded
  `launchctl` environment and reject any mismatch or explicit command override.
- [x] Probe every ordered `fallbacks[]` entry and mirror runtime model and
  custom `apiKeyService` precedence.
- [x] Use the runtime's absent-cwd fallback (`HOME`), project the loaded
  instance environment, instance name, and provider-only MCP socket context,
  and fail closed when sandbox-per-chat or dynamic egress context cannot be
  reproduced safely.
- [x] Harden both runtime and health reads of OpenCode `auth.json` against
  symlinks, loose file modes, ownership mismatch, and oversized payloads.
- [x] Resolve provider binaries through the launcher's shared effective-PATH
  contract, including its post-launchd local-bin and pinned-Node prefixes, and
  cover the shadowing collision with a regression test. Pin and materialize the
  helper in the BOT ERRORS deployment packet, and keep its calculation free of
  commands resolved through the inherited PATH.
- [ ] Obtain fresh exact-head approval and complete publication/deployment
  proof without carrying forward claims from an older head.

## Verification Receipt

- An earlier platform head passed the repository push gate (50/50), TypeScript
  checks, runtime-manifest guards, and focused fallback/config/session suites.
- The repository-wide publication release audit remains non-clean because of
  pre-existing archive findings; the staged publication guard passed. The full
  health-check test file also retains one unrelated macOS `/tmp` descriptor-walk
  baseline failure, so neither result is represented as clean.
- That earlier macOS LaunchAgent deployment loaded its exact pushed code commit and passed
  authenticated health, preflight, generated-permission, service-PATH stdin,
  provider-terminal, single outbound-terminal, and WhatsApp echo checks.
- Historical evidence remains fail-closed: one older group turn lacks terminal
  proof, and three legacy completed-delivery identity admissions remain
  quarantined. These records were not deleted or marked resolved by this work.
- Host-specific identifiers, message bodies, hashes, and rollback artifacts are
  retained only in the private operation receipt.
- The first independent-review remediation had 573 changed-suite passes plus
  142/142 health checks after explicitly excluding the inherited macOS
  descriptor-walk fixture; that excluded fixture remains inconclusive, not
  clean. The current Task 9 exact-SHA push/CI/re-review remains pending; earlier
  evidence is not promotion proof for the current head.
