# Security Review: Provider Permission Inheritance And Credential Isolation

Date: 2026-04-04

Scope: review of provider launch permissions, API key isolation, `sandboxPerChat` containment, provider cost controls, compromised-binary blast radius, and MCP socket isolation for agent-style providers such as Claude, Codex, and Gemini.

## Executive Summary

Current WhatSoup agent isolation is strong at the tool-routing layer, but weak at the operating-system trust boundary.

The most important facts are:

1. Agent subprocesses are launched with full local-machine authority via `bypassPermissions` and are told they have full machine access.
2. API keys are loaded from shared GNOME Keyring entries and exported into the parent process environment.
3. `sandboxPerChat` creates per-chat workspaces and chat-scoped MCP sockets, but it does not create per-provider OS isolation.
4. There is no provider-specific rate limiting or cost circuit breaker today.
5. A compromised provider binary would likely escape the intended chat/workspace boundary because the current sandbox is hook-based, not OS-enforced.

Recommendation: do not make spawned Codex/Gemini agents "mirror our access, permissions, etc." by default. Mirror conversation context and explicitly approved tools. Do not mirror full machine authority, shared environment secrets, or cross-provider socket visibility.

## Evidence In Repo

- Agent subprocesses are launched with `--permission-mode bypassPermissions` and the prompt states "full access to the local machine": `src/runtimes/agent/session.ts:153-169`.
- Default agent settings also use `defaultMode: 'bypassPermissions'` and broad MCP wildcards: `src/core/settings-template.ts:19-50`.
- Shared keyring secrets are exported into the service environment:
  - chat instances export `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `PINECONE_API_KEY`: `deploy/whatsoup:37-56`
  - agent/passive instances export `OPENAI_API_KEY` and `PINECONE_API_KEY`: `deploy/whatsoup:57-73`
- Per-instance API key support is explicitly still TODO: `src/fleet/routes/ops.ts:545-547`.
- `sandboxPerChat` provisions per-chat `.mcp.json`, `whatsoup.sock`, and `media-bridge.sock`: `src/core/workspace.ts:183-225`.
- Chat-scoped sockets carry `conversationKey`, `deliveryJid`, and `allowedRoot`: `src/runtimes/agent/runtime.ts:1719-1737`, `src/mcp/types.ts:7-15`.
- MCP scope enforcement exists in the registry, but socket clients are not authenticated beyond filesystem access: `src/mcp/registry.ts:165-245`, `src/mcp/socket-server.ts:48-103`.
- Workspace `.claude/` directories are created without explicit `0700` mode in the per-chat path: `src/core/workspace.ts:186-188`.
- WhatSoup runs as a systemd user service, not as isolated per-provider users: `docs/runbook.md:45`, `deploy/whatsoup@.service:10-30`.
- Existing "rate limit" and "token budget" controls are chat-runtime controls, not provider spend controls: `src/config.ts:165-167`, `src/runtimes/chat/runtime.ts:156-170`, `src/runtimes/chat/runtime.ts:243-253`.

## 1. Implications Of Passing `--dangerously-bypass-approvals-and-sandbox` To Codex

This should be treated as equivalent in spirit to the current Claude `bypassPermissions` launch, and possibly worse if it disables both approval prompts and any sandbox layer that the provider would otherwise enforce.

Security impact:

- Prompt injection becomes code execution with the service account's privileges.
- Any provider-side bug or malicious tool/plugin can read inherited environment variables and local files.
- Hook-based controls are no longer a trustworthy security boundary because the provider process itself is trusted to honor them.
- The risk is not just "the model can use more tools"; it becomes "the provider binary can do anything the Unix user can do."

Recommendation:

- Do not use `--dangerously-bypass-approvals-and-sandbox` for untrusted or semi-trusted chats.
- If a provider needs elevated access, make that a separate provider profile with a separate Unix user, separate secrets, separate runtime directory, and separate cost limits.
- Default posture for alternate providers should be least privilege: explicit tool allowlist, explicit env allowlist, explicit socket allowlist, no inherited broad machine access.

## 2. How API Keys Should Be Isolated Per Provider

Use GNOME Keyring or another secret manager as the source of truth. Do not store raw API keys in per-instance config files.

Recommended model:

- `config.json` stores secret references only, not secret values.
- Secrets are namespaced by at least:
  - provider
  - instance
  - purpose
- Example keyring attributes:
  - `service=whatsoup_api_key`
  - `provider=openai|anthropic|google|pinecone`
  - `instance=<line-name>`
  - `purpose=chat|transcription|memory|agent`

Why not per-instance config files:

- config files are easier to copy, back up, expose through logs, and accidentally commit.
- they widen the blast radius from runtime compromise to filesystem compromise.

Why not only one shared key per provider:

- it couples cost, rotation, and incident response across all instances.
- one compromised instance can burn the entire provider account budget.
- it prevents selective revocation.

Preferred implementation pattern:

- Parent process or a dedicated credential broker fetches only the exact key needed for the exact provider operation.
- Child processes receive only the one credential they need, or no credential at all if the parent proxies the request.
- The ideal end state is brokered access instead of raw key distribution to provider subprocesses.

## 3. Preventing One Provider From Accessing Another Provider's Credentials In `sandboxPerChat`

Today, `sandboxPerChat` isolates workspace paths and tool scope, but not credentials. The parent service exports `OPENAI_API_KEY` and `PINECONE_API_KEY` for agent/passive instances, and `SessionManager` spawns the child without an explicit `env` override. By inference from Node's `spawn` behavior, the child inherits the parent environment.

That means the current design does not prevent one provider session from accessing another provider's credentials if that session can inspect its environment or run arbitrary code.

Required controls:

1. Explicit child env allowlists.
2. Provider-specific secret namespaces.
3. Separate Unix principals for materially different trust domains.

Minimum acceptable pattern:

- For each provider child process, set `env` explicitly.
- Pass only:
  - `PATH`
  - locale basics if needed
  - provider-specific socket path
  - one provider-specific credential, if unavoidable
- Do not pass unrelated keys such as Pinecone to Codex, OpenAI to Gemini, or Google keys to Claude.

Stronger pattern:

- Provider subprocesses get no raw provider API keys at all.
- A parent-side broker performs provider API calls over a narrow local IPC contract.
- The broker enforces provider routing, quotas, and audit logging.

Important conclusion:

`sandboxPerChat` should be described as chat/workspace isolation, not credential isolation. Credential isolation only exists after env separation or credential brokering is implemented.

## 4. Provider Rate Limiting And Runaway Cost Controls

Yes, API providers should have rate limiting and spend controls.

Current controls in repo are insufficient for this problem:

- `rateLimitPerHour` limits user message handling in chat runtime.
- `tokenBudget` trims prompt context.
- neither one is a provider quota or spend circuit breaker.

Recommended controls:

- Per-provider requests/minute.
- Per-provider tokens/minute.
- Per-instance daily spend cap.
- Per-chat burst cap.
- Automatic cool-down after repeated provider failures or repeated 429s.
- Alerting when usage crosses thresholds such as 50%, 80%, and 95% of budget.
- Hard kill switch for a provider-instance combination.

Priority order:

1. hard spend cap per provider-instance
2. request/token rate limits
3. anomaly detection for runaway loops
4. operator-visible audit trail

## 5. Compromised Provider Binary: Blast Radius Analysis

### Current Non-Sandboxed Agent

Blast radius is effectively the whole service account:

- full inherited process environment
- all files accessible to that Unix user
- all instance configs readable by that user
- all sockets readable/connectable by that user, subject to filesystem permissions
- network egress for exfiltration
- any plugins or helper binaries reachable in the user's home directory

This is especially severe because WhatSoup runs as a systemd user service, not as separate provider users.

### Current `sandboxPerChat` With Honest Provider

Blast radius is narrower if the provider behaves correctly:

- workspace files under the chat workspace
- chat-scoped MCP tools only
- chat-specific delivery target injection
- media bridge restricted to the workspace root

This is the intended model enforced by `ToolRegistry`, `SessionContext`, and the sandbox hook.

### Current `sandboxPerChat` With Compromised Provider Binary

Blast radius expands again toward the whole service account:

- hook-based sandboxing is no longer trustworthy if the provider binary is malicious or vulnerable
- inherited environment secrets are exposed
- any same-user file/socket reachable outside the workspace becomes a target
- per-chat socket separation does not help if the attacker can enumerate other accessible socket paths on disk

Conclusion:

The current blast radius is bounded by OS permissions, not by chat-scoped MCP logic. The chat-scoped logic is defense in depth, not the root containment boundary.

### Recommended Target Blast Radius

Use a separate Unix user or container namespace per provider family, and ideally per high-risk instance. Then a compromised provider binary should be limited to:

- its own runtime directory
- its own provider credential
- its own sockets
- its own logs
- outbound network only to approved destinations if feasible

That turns a provider compromise from "whole bot host user" into "one provider sandbox."

## 6. MCP Server Socket Isolation Between Providers

Current socket isolation is path-based:

- each workspace gets its own `whatsoup.sock`
- each workspace gets its own `media-bridge.sock`
- global mode writes a single `.mcp.json` pointing at one socket

This is necessary, but not sufficient.

Weak points:

- `WhatSoupSocketServer` accepts any local client that can open the socket path.
- there is no peer credential check or per-connection authentication token.
- workspace directories in the per-chat provisioning path are not explicitly chmodded to `0700`.

Recommended socket model:

- runtime socket root under a private directory such as `/run/user/<uid>/whatsoup/<instance>/<provider>/<chat>/`
- explicitly `mkdir 0700` for every directory in the path
- explicitly `chmod 0600` or equivalent tight perms on socket files where supported
- one socket namespace per provider
- one `.mcp.json` per provider workspace, never shared across providers
- optional local authentication:
  - random per-workspace bearer token passed in env and validated on each JSON-RPC request
  - or peer credential validation if the platform supports it

Most important rule:

Never let provider A discover or inherit provider B's socket path.

## Recommended Decisions

### Decision 1

Do not mirror full host permissions across providers.

Mirror:

- working directory appropriate to that provider
- explicit tool allowlist
- explicit chat/session context
- explicit MCP endpoints needed for that provider

Do not mirror:

- full machine authority
- unrelated environment variables
- unrelated provider keys
- global plugin inheritance
- other providers' socket paths

### Decision 2

Keep secrets in GNOME Keyring or another secret manager, but namespace them per provider and per instance. Do not place raw keys in `config.json`.

### Decision 3

Treat `sandboxPerChat` as a convenience isolation feature, not a hard trust boundary, until OS-level separation is added.

### Decision 4

Add provider-level quotas before introducing more autonomous providers.

### Decision 5

If alternate providers must run with elevated local access, place them behind a higher-trust deployment path with separate Unix users and stronger incident response controls.

## Prioritized Remediation Plan

### P0

- Stop inheriting the full parent environment into provider subprocesses.
- Implement explicit `env` allowlists for child processes.
- Namespace secrets by provider and instance.

### P1

- Add per-provider and per-instance budget controls.
- Add `0700` permissions to per-chat workspace and `.claude/` directories.
- Move provider sockets into a dedicated private runtime tree.

### P2

- Add local socket authentication or peer credential validation.
- Reduce default global MCP/plugin wildcards for agent sessions.
- Add provider-specific audit logging for key use, socket use, and budget burn.

### P3

- Separate high-risk providers into dedicated Unix users or container sandboxes.
- Consider replacing raw key exposure with a brokered provider-call layer.

## Bottom Line

If the goal is "spawned Codex/Gemini agents should feel like they have the same capabilities," the secure version of that goal is:

"same workflow access, explicitly re-granted through narrow interfaces."

It should not mean:

"same machine permissions, same inherited secrets, same sockets, and same billing authority."
