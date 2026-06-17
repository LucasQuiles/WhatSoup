/**
 * tool-update.ts — tool_use → structured ToolUpdate formatting and tool-error
 * humanization for AgentRuntime's outbound display.
 *
 * Extracted verbatim from runtime.ts module scope (module-level FILE-reduction slice
 * of the god-class decomposition; behavior unchanged — pure relocation). buildToolUpdate
 * is re-exported by runtime.ts to preserve the original public surface; humanizeError is
 * imported back by runtime.ts's classifyToolError.
 */
import type { ToolUpdate } from './outbound-queue.ts';
/**
 * Build a structured ToolUpdate from a tool_use event.
 * detail is capped at 80 visible chars.
 * Exported for unit testing.
 */
export function buildToolUpdate(toolName: string, input: Record<string, unknown>): ToolUpdate {
  const str = (key: string): string => String(input[key] ?? '');

  /** Strip home-dir prefixes, make relative, and middle-truncate to 80 chars. */
  function shortPath(p: string): string {
    // Strip any /home/<user>/ prefix to avoid leaking absolute paths
    const rel = p.replace(/^\/home\/[^/]+\//, '~/').replace(/^~\/LAB\/[^/]+\//, '');
    if (rel.length <= 80) return rel;
    const half = 38;
    return rel.slice(0, half) + '…' + rel.slice(-(80 - half - 1));
  }

  /** End-truncate a string to 160 chars (fits WhatsApp status lines without mid-word cuts). */
  function trunc(s: string): string {
    return s.length <= 160 ? s : s.slice(0, 159) + '…';
  }

  switch (toolName) {
    case 'Read': {
      const p = shortPath(str('file_path'));
      const limit = input['limit'];
      const offset = input['offset'];
      const startLine = Number(offset ?? 1);
      const endLine = limit != null ? startLine + Number(limit) - 1 : '?';
      const range = (limit != null || offset != null) ? `\n→ \`(L${startLine}-L${endLine})\`` : '';
      return { category: 'reading', detail: trunc(`\`${p}\`${range}`) };
    }
    case 'Edit':
    case 'Write':
      return { category: 'modifying', detail: `\`${shortPath(str('file_path'))}\`` };
    case 'Glob': {
      const scope = str('path');
      const pat = trunc(str('pattern'));
      // Two-line format keeps backtick pairs closed even with long patterns/paths
      const detail = scope ? `\`${pat}\`\n→ \`${shortPath(scope)}\`` : `\`${pat}\``;
      return { category: 'searching', detail };
    }
    case 'Grep': {
      const scope = str('glob') || str('path');
      const pat = trunc(str('pattern'));
      const detail = scope ? `\`${pat}\`\n→ \`${shortPath(scope)}\`` : `\`${pat}\``;
      return { category: 'searching', detail };
    }
    case 'Bash': {
      const desc = str('description');
      // Human-readable descriptions stay plain; raw commands get monospace
      if (desc) return { category: 'running', detail: trunc(desc) };
      const firstLine = str('command').split('\n').find((l) => l.trim()) ?? str('command');
      return { category: 'running', detail: `\`${trunc(firstLine)}\`` };
    }
    case 'Agent': {
      const type = str('subagent_type') || 'agent';
      const label = type.replace(/-/g, ' ');
      const desc = str('description') || trunc(str('prompt'));
      return { category: 'agent', detail: trunc(`${label}: ${desc}`) };
    }
    case 'WebFetch': {
      const url = str('url').replace(/^https?:\/\//, '').replace(/\?.*$/, '');
      return { category: 'fetching', detail: trunc(`\`${url}\``) };
    }
    case 'WebSearch':
      return { category: 'fetching', detail: trunc(`\`${str('query')}\``) };
    case 'Skill':
      return { category: 'skill', detail: `\`${trunc(str('skill') || 'skill')}\`` };
    case 'TodoWrite':
      return { category: 'planning', detail: 'Updating todos' };
    case 'TaskCreate':
      return { category: 'planning', detail: trunc(str('subject') || 'Creating task') };
    case 'TaskUpdate':
      return { category: 'planning', detail: `Updating task ${str('taskId')}` };
    case 'TaskList':
    case 'TaskGet':
      return { category: 'planning', detail: 'Checking tasks' };
    case 'ToolSearch':
      return { category: 'skill', detail: `\`${trunc(str('query') || 'tools')}\`` };
    case 'LS':
      return { category: 'reading', detail: `\`${shortPath(str('path') || '.')}\`` };
    case 'NotebookEdit':
    case 'NotebookRead':
      return { category: 'modifying', detail: `\`${shortPath(str('notebook'))}\`` };
    case 'LSP':
      return { category: 'searching', detail: trunc(str('command') || 'language server') };
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return { category: 'planning', detail: toolName === 'EnterPlanMode' ? 'Planning' : 'Executing plan' };
    case 'SendMessage':
      return { category: 'agent', detail: trunc(`→ ${str('to')}`) };
    case 'AskUserQuestion':
      return { category: 'other', detail: 'Asking a question' };
    default: {
      // MCP tools: "mcp__<server>__<tool-name>" → human-readable monospace tool name
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const rawTool = parts[parts.length - 1] ?? toolName;

        // Friendly labels for tools that shouldn't expose internals to users
        if (rawTool === 'knowledge_search') {
          const query = trunc(str('query') || '');
          return { category: 'searching', detail: query ? `Checking my notes on ${query}` : 'Checking my notes' };
        }

        const tool = rawTool.replace(/[-_]/g, ' ');
        return { category: 'other', detail: `\`${trunc(tool)}\`` };
      }
      return { category: 'other', detail: `\`${trunc(toolName)}\`` };
    }
  }
}

/**
 * Rewrite common technical error messages into casual, user-friendly language.
 * Returns null if no rewrite matches (use the original).
 */
export function humanizeError(_toolName: string, text: string): string | null {
  const lower = text.toLowerCase();

  // File too large to read
  if (lower.includes('exceeds maximum allowed tokens') || lower.includes('content too large'))
    return '_that file was a bit long, reading just the parts I need_';
  // File not found
  if (lower.includes('no such file') || lower.includes('file not found') || lower.includes('enoent'))
    return '_file not found, looking for the right path_';
  // Command not found
  if (lower.includes('command not found'))
    return '_command not found, trying another approach_';
  // Timeout
  if (lower.includes('timed out') || lower.includes('timeout'))
    return '_that took too long, retrying_';
  // Network / connection errors
  if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('fetch failed'))
    return '_connection failed, will retry_';
  // No matches found (grep/glob)
  if (lower.includes('no matches found') || lower.includes('no files found'))
    return '_no results, refining search_';
  // Git conflicts
  if (lower.includes('merge conflict'))
    return '_merge conflict detected, resolving_';
  // Rate limit / overloaded
  if (lower.includes('rate limit') || lower.includes('overloaded') || lower.includes('429'))
    return '_rate limited, waiting a moment_';
  // Syntax/parse errors
  if (lower.includes('syntax error'))
    return '_syntax error, fixing_';
  // Disk / storage
  if (lower.includes('enospc') || lower.includes('no space left'))
    return '_disk full, freeing space_';
  // Process / memory
  if (lower.includes('enomem') || lower.includes('out of memory') || lower.includes('killed'))
    return '_out of memory, scaling down_';
  // Invalid JSON / parse
  if (lower.includes('unexpected token') || lower.includes('json parse') || lower.includes('invalid json'))
    return '_got malformed data, retrying_';
  // String replacement not found (Edit tool)
  if (lower.includes('not found in file') || lower.includes('old_string'))
    return '_text not found in file, re-reading to get the right context_';
  // Git push / pull errors
  if (lower.includes('rejected') && lower.includes('push'))
    return '_push rejected, pulling latest changes first_';
  // Max context / token budget
  if (lower.includes('context window') || lower.includes('max_tokens') || lower.includes('context length'))
    return '_hitting context limits, compacting_';
  // Exit code (generic — keep it brief)
  if (/^exit code \d+$/i.test(text.trim()))
    return `_exited with error, continuing_`;

  return null;
}
