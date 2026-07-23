// src/runtimes/agent/commands.ts
import { isProviderId } from './providers/index.ts';
import { COMMAND_REGISTRY, type CommandSpec, type LocalCommandName } from './command-registry.ts';
// Classifies incoming user input as a local command, forwarded slash command,
// or a regular message to be passed through to the agent.

export type CommandResult =
  | { type: 'local'; command: LocalCommandName; args?: string }
  | { type: 'forwarded'; text: string }
  | { type: 'message'; text: string };

// Widen the narrow `as const` tuple to the interface array so optional-field
// reads (routingAlias/subVerbs) typecheck on entries that omit them.
const REGISTRY: readonly CommandSpec[] = COMMAND_REGISTRY;

/** Commands handled locally by the bot runtime. */
const LOCAL_COMMANDS = new Set(REGISTRY.filter((c) => !c.routingAlias).map((c) => c.name));

/** NL-first routing aliases (owner-approved design) — classified local ONLY
 *  when the caller enables them (nlRouting flag), so flag-off behavior stays
 *  byte-identical to today (/model etc. keep forwarding). Routing preference
 *  and visibility only, never tool/authority changes (capability-preserved). */
const ROUTING_ALIAS_COMMANDS = new Set(REGISTRY.filter((c) => c.routingAlias).map((c) => c.name));

/** `/model` sub-verbs owned locally when routing aliases are on. Anything
 *  else (e.g. `/model sonnet`) falls through to `forwarded` so the base
 *  capability of driving the agent session's own /model keeps working (F04). */
const ROUTING_MODEL_VERBS = new Set(REGISTRY.find((c) => c.name === 'model')?.subVerbs ?? []);

/** A bare catalogue index or index+letter arg, e.g. "2" or "2b" (C1 structured
 *  grammar — `/model <N>` / `/model <N><letter>`). Case-insensitive so "2B"
 *  also counts as structured. */
const MODEL_INDEX_RE = /^\d+[a-z]?$/i;

/** True when `parts` (the full `/model ...` token list; `parts[0]` is always
 *  "model") matches the STRUCTURED /model grammar the bot owns locally under
 *  the agent-assisted design (owner decision 2026-07-20): bare `/model`, a
 *  known verb or compiled-in provider id, a catalogue index (`N` / `N<letter>`),
 *  `N default`, or `list [filter...]`. Genuine free text (e.g. "the best
 *  kimi") returns false so it falls through to `forwarded` — the
 *  `route_pin`-tool-equipped agent owns NL disambiguation, and the base
 *  capability of driving the agent session's own /model keeps working (F04). */
function isStructuredModelArg(parts: readonly string[]): boolean {
  if (parts.length === 1) return true;
  const arg1 = parts[1].toLowerCase();
  if (arg1 === 'list') return true; // bare "list" or with a filter tail of any length
  if (parts.length === 2) {
    return ROUTING_MODEL_VERBS.has(arg1) || isProviderId(arg1) || MODEL_INDEX_RE.test(parts[1]);
  }
  if (parts.length === 3 && /^\d+$/.test(parts[1]) && parts[2].toLowerCase() === 'default') {
    return true;
  }
  return false;
}

/**
 * Classify a user input string.
 *
 * - `/new`, `/status`, `/help` (case-insensitive) → local
 * - `/model`, `/reset` → local only when `opts.routingAliases` is true,
 *   and only for recognized grammar: `/model`'s STRUCTURED set (bare, a known
 *   verb/provider-id, `N`/`N<letter>` catalogue index, `N default`, or
 *   `list [filter]`), bare `/reset` — genuine free text (e.g.
 *   "/model the best kimi") still forwards to the agent (F04). D11: `/why` is
 *   removed from the registry, so it always forwards now.
 * - Bare `/` (with optional trailing whitespace) → local `/help` menu
 * - Any other `/…` slash command → forwarded (passed through to Claude Code)
 * - No leading `/` → message
 */
export function classifyInput(text: string, opts?: { routingAliases?: boolean }): CommandResult {
  if (!text.startsWith('/')) {
    return { type: 'message', text };
  }

  // Extract the command name: the word directly after the leading slash,
  // lowercased. E.g. "/Compact arg" → "compact".
  // Filter empty split elements so a trailing space (e.g. "/reset ") does not
  // inflate parts.length and knock a bare routing alias out of its
  // `parts.length === 1` grammar — matching the base local commands, which key
  // only on the command name and already tolerate a trailing space (R10).
  const rest = text.slice(1);
  const parts = rest.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { type: 'local', command: 'help' };
  }
  const commandName = (parts[0] ?? '').toLowerCase();

  const routingAlias =
    opts?.routingAliases === true &&
    ROUTING_ALIAS_COMMANDS.has(commandName) &&
    // Recognized grammar only — everything else keeps the base forwarded
    // behavior so no pre-existing capability silently regresses (F04).
    // Instance-level pin eligibility stays the handler's job (F07).
    (commandName === 'model' ? isStructuredModelArg(parts) : parts.length === 1);
  const isLocal = LOCAL_COMMANDS.has(commandName) || routingAlias;
  if (isLocal) {
    const args = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
    return {
      type: 'local',
      command: commandName as LocalCommandName,
      args,
    };
  }

  return { type: 'forwarded', text };
}
