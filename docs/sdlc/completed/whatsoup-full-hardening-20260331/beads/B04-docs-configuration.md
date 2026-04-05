# Bead: B04-docs-configuration
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** docs/configuration.md
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** docs/sdlc/active/whatsoup-full-hardening-20260331/beads/B04-decision-trace.md
**Deterministic checks:** [file-exists]
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
No configuration documentation exists. Scout identified 21 env vars (README covers 9) and `instance.json` schema is entirely undocumented.

Source files to read:
- `src/config.ts` — env var resolution, defaults, `intEnv()` helper
- `src/instance-loader.ts` — instance.json validation, full schema
- `src/core/health.ts` — `WHATSOUP_HEALTH_TOKEN`
- `src/runtimes/chat/providers/pinecone.ts` — `PINECONE_API_KEY`
- `instances/*/instance.json` — working examples

## Output
`docs/configuration.md` containing:
1. Complete env var table (all 21 vars with defaults, types, precedence)
2. `instance.json` schema reference with all fields documented
3. Worked examples for each instance type (agent, chat, passive)
4. Config resolution order (instance.json > env > hardcoded default)
5. API key requirements (implicit SDK env vars)
