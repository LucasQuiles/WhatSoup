# Required Tools

- `npx vitest run ... --pool=forks` for targeted tests.
- `npm run typecheck` for TypeScript.
- `git diff --name-only HEAD` and `rg` for scope/import inspection.

# Required Skills

- `superpowers:executing-plans` or `superpowers:subagent-driven-development` for task-by-task execution.
- `planprompt-review` for this hardening pass.

# Relevant MCPs and Plugins

No external MCP mutation is required. Code search may be local `rg`; Pinecone search is optional and read-only.

# Subagent Lanes

Optional only when explicitly requested. Safe lanes: refs/types, queue/fanout, test adapters/tests.

# Ownership and Write Scope

Allowed writes: `src/core/transport-refs.ts`, `src/transport/contract/**`, `src/transport/testing/**`, `tests/core/**`, `tests/transport/contract/**`.

# Evidence Outputs

Each lane emits changed paths, test commands, and artifact paths under `artifacts/`.

# Deterministic Validation Safeguards

No live providers, no network dependency, no production config/logging/schema changes.
