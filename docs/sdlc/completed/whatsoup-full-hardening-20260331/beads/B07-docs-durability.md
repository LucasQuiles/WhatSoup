# Bead: B07-docs-durability
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** docs/durability.md
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** docs/sdlc/active/whatsoup-full-hardening-20260331/beads/B07-decision-trace.md
**Deterministic checks:** [file-exists]
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
Durability recovery algorithm fully documented in JSDoc comments in code but no prose reference.

Source file: `src/core/durability.ts` — the entire algorithm, state machine, and recovery logic.

## Output
`docs/durability.md` containing:
1. Durability design rationale (why two-phase commit for WhatsApp)
2. State machines for inbound events and outbound ops (with transitions)
3. Pre-connect recovery algorithm (step by step)
4. Post-connect recovery algorithm (step by step)
5. Periodic sweep behavior
6. Operational notes: quarantined ops, recovery_runs table, 30s grace period, MCP tool exclusion
