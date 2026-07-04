// src/runtimes/agent/commands.ts
// Classifies incoming user input as a local command, forwarded slash command,
// or a regular message to be passed through to the agent.

export type CommandResult =
  | { type: 'local'; command: 'new' | 'status' | 'help' | 'sessions' | 'kill-session' | 'model' | 'why' | 'reset'; args?: string }
  | { type: 'forwarded'; text: string }
  | { type: 'message'; text: string };

/** Commands handled locally by the bot runtime. */
const LOCAL_COMMANDS = new Set(['new', 'status', 'help', 'sessions', 'kill-session']);

/** NL-first routing aliases (owner-approved design) — classified local ONLY
 *  when the caller enables them (nlRouting flag), so flag-off behavior stays
 *  byte-identical to today (/model etc. keep forwarding). Routing preference
 *  and visibility only, never tool/authority changes (capability-preserved). */
const ROUTING_ALIAS_COMMANDS = new Set(['model', 'why', 'reset']);

/**
 * Classify a user input string.
 *
 * - `/new`, `/status`, `/help` (case-insensitive) → local
 * - `/model`, `/why`, `/reset` → local only when `opts.routingAliases` is true
 * - Any other `/…` slash command → forwarded (passed through to Claude Code)
 * - No leading `/` → message
 */
export function classifyInput(text: string, opts?: { routingAliases?: boolean }): CommandResult {
  if (!text.startsWith('/')) {
    return { type: 'message', text };
  }

  // Extract the command name: the word directly after the leading slash,
  // lowercased. E.g. "/Compact arg" → "compact".
  const rest = text.slice(1);
  const parts = rest.split(/\s+/);
  const commandName = parts[0].toLowerCase();

  const isLocal =
    LOCAL_COMMANDS.has(commandName) ||
    (opts?.routingAliases === true && ROUTING_ALIAS_COMMANDS.has(commandName));
  if (isLocal) {
    const args = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
    return {
      type: 'local',
      command: commandName as 'new' | 'status' | 'help' | 'sessions' | 'kill-session' | 'model' | 'why' | 'reset',
      args,
    };
  }

  return { type: 'forwarded', text };
}
