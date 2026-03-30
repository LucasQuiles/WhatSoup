// src/runtimes/agent/commands.ts
// Classifies incoming user input as a local command, forwarded slash command,
// or a regular message to be passed through to the agent.

export type CommandResult =
  | { type: 'local'; command: 'new' | 'status' | 'help' }
  | { type: 'forwarded'; text: string }
  | { type: 'message'; text: string };

/** Commands handled locally by the bot runtime. */
const LOCAL_COMMANDS = new Set(['new', 'status', 'help']);

/**
 * Classify a user input string.
 *
 * - `/new`, `/status`, `/help` (case-insensitive) → local
 * - Any other `/…` slash command → forwarded (passed through to Claude Code)
 * - No leading `/` → message
 */
export function classifyInput(text: string): CommandResult {
  if (!text.startsWith('/')) {
    return { type: 'message', text };
  }

  // Extract the command name: the word directly after the leading slash,
  // lowercased. E.g. "/Compact arg" → "compact".
  const rest = text.slice(1);
  const commandName = rest.split(/\s+/)[0].toLowerCase();

  if (LOCAL_COMMANDS.has(commandName)) {
    return { type: 'local', command: commandName as 'new' | 'status' | 'help' };
  }

  return { type: 'forwarded', text };
}
