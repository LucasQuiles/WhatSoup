// src/runtimes/agent/config-surface.ts
//
// The `/config` surface — Q's one-namespace design (CONFIG-SURFACE-MAP.md) where
// ARG-COUNT decides read-vs-write, so discovery and mutation are the same command
// without a second surface. This module is the DETERMINISTIC action layer (owner
// directive 2026-07-20: every check the menu drives is code in the action, not
// the LLM; the LLM only triggers). It lives OUTSIDE runtime.ts so the growing
// command surface never bloats that file (already at its arch.file-size ceiling)
// and stays pure/unit-testable.
//
// This first slice is the GRAMMAR layer only: parse the raw argument string into
// a typed action. Validating the axis NAME against the registry and the VALUE
// against the live catalogue (fail-open shape gate, Q R2) belongs to the executor
// — a later slice — so this parser has no registry/catalogue dependency and is
// a pure function.

/**
 * A parsed `/config` invocation. Arg-count is the discriminator (Q): bare →
 * overview, one token → read that axis, `<axis> default` → unset, `<axis>
 * <value>` → write. `axis` is lowercased (canonical id); `value` preserves case
 * (model ids may be mixed-case, e.g. `minimax/MiniMax-M2`).
 */
export type ConfigAction =
  | { kind: 'overview' }
  | { kind: 'read'; axis: string }
  | { kind: 'unset'; axis: string }
  | { kind: 'write'; axis: string; value: string };

/** The reserved value that returns an axis to its inherited/default (Q R7 unset). */
const UNSET_KEYWORD = 'default';

/**
 * Parse a `/config` argument string into a {@link ConfigAction}. Pure and total:
 * every input maps to exactly one action shape. Unknown axes / invalid values are
 * NOT rejected here — the executor validates them against the axis registry and
 * the live catalogue so the error carries per-axis context (structured error
 * taxonomy, `designing-agent-clis`); this layer only shapes the grammar.
 */
export function parseConfigCommand(rawArgs: string): ConfigAction {
  const trimmed = rawArgs.trim();
  if (trimmed === '') return { kind: 'overview' };

  // First whitespace-run splits the axis token from the rest (the value, which
  // may itself contain spaces — the executor interprets it per axis).
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  // The regex always matches a non-empty trimmed string; the fallback keeps the
  // function total without a non-null assertion.
  const axis = (match?.[1] ?? trimmed).toLowerCase();
  const value = (match?.[2] ?? '').trim();

  if (value === '') return { kind: 'read', axis };
  if (value.toLowerCase() === UNSET_KEYWORD) return { kind: 'unset', axis };
  return { kind: 'write', axis, value };
}
