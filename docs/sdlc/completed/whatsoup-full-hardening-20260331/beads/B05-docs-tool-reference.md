# Bead: B05-docs-tool-reference
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** docs/tools.md, scripts/generate-tool-docs.ts (temporary)
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** docs/sdlc/active/whatsoup-full-hardening-20260331/beads/B05-decision-trace.md
**Deterministic checks:** [file-exists]
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
117 MCP tools with zero human-readable documentation. Each tool has `name`, `description`, `scope`, `replayPolicy`, `targetMode`, and Zod schema with `.describe()` annotations.

The registry already has `listTools()` and `zodToJsonSchema()`. Auto-generation is straightforward.

Source files:
- `src/mcp/tools/*.ts` — 13 modules with all tool declarations
- `src/mcp/registry.ts` — `listTools()`, schema conversion
- `src/mcp/register-all.ts` — canonical registration order

## Output
`docs/tools.md` — Complete MCP tool reference organized by module:
- Tool name, description, scope, replay policy
- Parameters table (name, type, required, description)
- Grouped by module (messaging, media, groups, etc.)
