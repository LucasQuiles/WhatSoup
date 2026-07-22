# 05 — WS2.6 Instance-Model Investigation (R2-5)

Sources: `docs/configuration.md` (1,455 lines), `console/src/types.ts`, CLAUDE.md instance model,
`restart-reliability` worktree @ fix/q-restart-reliability. Date: 2026-07-21.

## 1. The runtime model as it exists

**Instance** = one process + one config at `$XDG_CONFIG_HOME/whatsoup/instances/<name>/config.json`.
Config schema has **3 types**: `passive` | `chat` | `agent`. The "4 instance models" are
deployment archetypes over those types:

| Deployment archetype | type | MCP tier | sessionScope | Purpose |
|---|---|---|---|---|
| primary-line | passive | global | — | MCP-only passive line for manual oversight; no auto-response |
| operator-agent | agent | global | single/shared | full-access autonomous agent |
| sandbox-agent | agent | chat-scoped | per_chat (+sandboxPerChat) | sandboxed per-chat agent, isolated workspace per chat |
| chat-bot | chat | chat-scoped | — | direct LLM API chat, no MCP, no agent loop |

**Mode** (console vocabulary) = the same triple: passive/chat/agent — load-bearing, kept.

## 2. Config surface inventory (what a profile must cover)

| Field group | Content | v3.5 home |
|---|---|---|
| `type` / mode | passive/chat/agent | Agent archetype |
| `accessMode` | self_only · allowlist · open_dm · groups_only (self_only required for passive) | Line/Agent access policy |
| `systemPrompt` | forbidden passive, required chat, optional agent (default fallback) | Persona (soul) |
| `models` | conversation · extraction · validation · fallback | Brain |
| `agentOptions.provider` | claude-cli · codex-cli · gemini-cli · opencode-cli · openai-api · anthropic-api | Brain (harness) |
| `agentOptions.providerConfig` | baseUrl + apiKeyService (custom endpoints) | Brain |
| `agentOptions.fallbacks[]` | ≤8 provider/model pairs; API entries require model | Brain (resilience) |
| `agentOptions.sessionScope` | single · shared · per_chat | Instance policy |
| `agentOptions.sandbox` | allowedPaths · allowedTools · allowedMcpTools · bash policy | Tool permissions (R3-9) |
| `agentOptions.enabledPlugins` | plugin@marketplace on/off map | Skills (hub underneath) |
| `agentOptions.pluginDirs` | extra plugin dirs | Skills |
| `agentOptions.mcp` | MCP feature flags | Tool permissions |
| `agentOptions.cwd` / `sandboxPerChat` | workspace root; per-chat workspace (requires per_chat) | Instance policy |
| `agentOptions.autoCompactInputTokens` | context auto-compact (150k default) | Brain (advanced) |
| `agentOptions.nlRouting*` | model-routing aliases + tier map | Brain (routing) |
| `memory` (BYOK) | Pinecone: index · searchMode · rerank · topK · allowedIndexes | Memory surface (R3-5) |
| `transport` + selected nested config | **baileys (WhatsApp) · twilio (SMS) · signal · imessage**; exactly the selected non-Baileys config is persisted | Channel |
| rate/budget | rateLimitPerHour · tokenBudget · maxTokens | Profile (limits) |
| identity | name · adminPhones · siblingPhones · chatAliases | Line |
| access_list (DB) | phone/group subjects: allowed · blocked · pending · seen | Line access (senders) |

## 3. Console projection (LineInstance today)

name · phone · mode · status (+confidence/reason/evidence) · accessMode · healthPort · uptime ·
heartbeat[] · messages · unread · queueDepth · activeSessions · lastSessionStatus · models ·
sandboxPerChat · chatCounts {chats, groups} · tokenUsage · linkedStatus (+confidence) · tags ·
group · config — plus ProviderStatus (primary/fallback slots, chain, telemetry).

The current `linkedStatus` projection is Baileys-specific: it derives WhatsApp health/auth evidence
and auth-directory artifacts. It is not truthful generic provider health for Twilio, Signal, or
iMessage; v3.5 must not present it as transport-neutral linkage until those adapters expose a
separate observed lifecycle contract.

## 4. Key discoveries

1. **Four transports have runtime/config seams** — Baileys/WhatsApp, Twilio/SMS, Signal, and
   iMessage are real choices in the schema and Add Line flow. The registry should mark those four
   as runtime-backed; the other ten entries are designed mocks (D2).
2. **Line ≡ Instance ≡ Agent are fused today.** An agent instance *is* a line: it owns the
   selected transport connection AND the agent runtime. v3.5's core split (Line = channel account, Agent =
   assignable worker) has no runtime basis yet — it's a **UI/product-model projection** over
   fused instances. D2 adds no fifth transport or Line/Agent split; it projects the four existing
   runtime seams into the design model.
3. **access_list is sender access** (who may talk to the bot), NOT agent×line grants. The Grant
   entity (B3/R3-13/14) is net-new with no runtime analog — pure product-model addition.
4. **Memory is already per-instance BYOK Pinecone** — the Memory surface (R3-5) projects existing
   config + adds status/search UI. Obsidian: `regenerate_vault` admin tool exists — status
   surface projects it.
5. **Skills = enabledPlugins map + pluginDirs** — the Skills Hub (R3-3) projects this plus
   plugins/MCPs inventory; compatibility matrix needs a new metadata source (none exists).
6. **sessionScope single/shared/per_chat + activeSessions** in health gives R2-12 (instance
   inspect/pause/kill) a real data seam.
7. **Provider fallback chain** (≤8 entries, telemetry, recovery probes) already models
   brain-resilience; R3-8 lossless hot-swap handoff is a UX-layer addition (no runtime seam for
   context handoff today — flag as designed-behavior, runtime later).
8. **Deployments**: fleet APIs discover instances on ONE host. Admin lane (R3-16) has zero
   runtime basis — fully designed concept.

## 5. Archetype mapping (R2-4 + R3-12)

| Plain-language kind (hatch) | Archetype | Basis | Key defaults |
|---|---|---|---|
| Monitor (passive line) | primary-line | passive | self_only; no agent — Line property, not an Agent |
| Personal assistant | operator-agent | agent | global tier; single/shared; full tools |
| Community agent | sandbox-agent | agent | chat-scoped; per_chat; sandboxed workspace |
| Chat responder | chat-bot | chat | systemPrompt persona; no MCP |
| Custom | any | — | full archetype picker + all knobs |
| Quick Learner | any above | — | auto-profile generated from connected sources (consent beat) |

## 6. Gaps the product model must close

| # | Gap | v3.5 resolution |
|---|---|---|
| G-i | Line/Agent/Profile fused in one config | Split into 3 entities in product model; UI projects over per-line configs initially |
| G-ii | No Grant concept | New entity (agent × line × hidden/see/participate) + audit |
| G-iii | No 14-channel registry | New registry (14 entries; WhatsApp/SMS/Signal/iMessage runtime-backed, ten mocked) |
| G-iv | No reusable Profile | New entity; materializes into a line config on assign |
| G-v | No unified Person | New entity linking contacts across channels |
| G-vi | No skill compatibility metadata | Hub needs a manifest schema (model/harness compat) — design in WS4 |
| G-vii | No multi-host concept | Deployment entity (admin lane) |
| G-viii | No context-handoff seam for brain swap | Design UX contract now; runtime seam flagged for platform program |
