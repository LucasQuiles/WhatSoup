/**
 * tool-update.ts — tool_use → structured ToolUpdate formatting and tool-error
 * humanization for AgentRuntime's outbound display.
 *
 * Extracted verbatim from runtime.ts module scope (module-level FILE-reduction slice
 * of the god-class decomposition; behavior unchanged — pure relocation). buildToolUpdate
 * is re-exported by runtime.ts to preserve the original public surface; humanizeError is
 * imported back by runtime.ts's classifyToolError.
 */

/** Max chars of tool-failure error text included in an operator alert excerpt. */
const TOOL_FAILURE_ALERT_EXCERPT_CHARS = 1_200;
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
/**
 * Classify a tool_result error as either a blocked tool (permission/hook denial),
 * cancelled, or a genuine execution error. Returns an appropriate ToolUpdate with
 * user-friendly messaging.
 */
export function classifyToolError(toolName: string, content: string): ToolUpdate {
  // Strip internal XML-like tags from Claude error content
  const cleaned = content
    .replace(/<\/?tool_use_error>/g, '')
    .replace(/<\/?error>/g, '')
    .trim();

  const lower = cleaned.toLowerCase();

  const isCancelled =
    lower.startsWith('cancelled') ||
    lower.includes('tool call cancelled') ||
    lower.includes('was cancelled');

  const isBlocked =
    lower.includes('not allowed') ||
    lower.includes('permission denied') ||
    lower.includes('blocked by') ||
    lower.includes('hook blocked') ||
    lower.includes('denied by') ||
    lower.includes('not permitted') ||
    lower.includes('is not in the allow') ||
    lower.includes('disallowed');

  const category = isCancelled ? 'cancelled' : isBlocked ? 'blocked' : 'error';

  // Try human-friendly rewrite first (only for errors, not blocked/cancelled)
  if (category === 'error' && toolName !== 'unknown') {
    const humanized = humanizeError(toolName, cleaned);
    if (humanized) return { category, detail: humanized };
  }

  // Fallback: technical detail
  const firstLine = cleaned.split('\n')[0] ?? cleaned;
  const simplified = firstLine
    .replace(/^Cancelled:\s*parallel tool call\s+\S+\(.*$/, 'Cancelled')
    .replace(/^Exit code (\d+)$/, 'exit code $1');
  const reason = simplified.length > 100 ? simplified.slice(0, 99) + '…' : simplified;

  const humanName = toolName === 'unknown' ? '' : toolName;
  const detail = humanName ? `${humanName} — ${reason}` : reason;

  return { category, detail };
}

/**
 * Does a tool_result error carry a signature that an OPERATOR (not the agent)
 * may need to act on — free disk, restart a host, restore connectivity, or wait
 * out a provider throttle? These reflect host/runtime/provider health.
 *
 * Everything else in the `error` category — a search that found nothing, a
 * failed conditional, a missing path, a bad glob — is a normal agent-loop result
 * the agent recovers from inline (e.g. claude-cli marks any non-zero Bash exit
 * `is_error`). Those are NOT operator-actionable and must not page BOT ERRORS.
 */
export function isOperatorActionableToolError(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    // Disk exhaustion
    lower.includes('enospc') ||
    lower.includes('no space left') ||
    // Memory exhaustion
    lower.includes('enomem') ||
    lower.includes('out of memory') ||
    // Connectivity / integration down
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    // Provider throttle / capacity
    lower.includes('rate limit') ||
    lower.includes('overloaded') ||
    // Context / token budget exhaustion
    lower.includes('context window') ||
    lower.includes('context length') ||
    lower.includes('max_tokens')
  );
}

/**
 * Gate for `runtime-tool-error` BOT ERRORS alert emission.
 *
 * `blocked` (permission/hook denial) still pages — a tool repeatedly denied by a
 * hook or allowlist can signal a misconfiguration an operator must fix.
 *
 * `cancelled` never pages: a cancelled tool produced no result and is not itself a
 * fault. It is overwhelmingly collateral — claude-cli auto-cancels the remaining
 * siblings of a parallel batch when one sibling errors, or the turn is aborted. Any
 * operator-actionable signal is carried by the ERRORING sibling's own `error`
 * classification, which is gated independently below; paging on the cancelled
 * siblings only duplicates that as noise. (Pre-fix this was the dominant critical
 * false-positive: a benign Bash non-zero exit is suppressed as a benign `error`,
 * yet its cancelled Grep/Glob siblings each paged critical.)
 *
 * A plain execution `error` only pages when it carries an operator-actionable
 * infra/provider signature — otherwise it is benign, agent-recoverable noise.
 */
export function shouldEmitToolFailureAlert(
  category: ToolUpdate['category'],
  content: string,
): boolean {
  if (category === 'cancelled') return false;
  if (category !== 'error') return true;
  return isOperatorActionableToolError(content);
}

export function safeAlertSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'unknown';
}

export function alertEvidenceValue(value: string | null | undefined): string {
  const text = value == null || value.trim() === '' ? 'unknown' : value.trim();
  return text.replace(/@/g, ' at ');
}

export function alertExcerpt(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > TOOL_FAILURE_ALERT_EXCERPT_CHARS
    ? `${cleaned.slice(0, TOOL_FAILURE_ALERT_EXCERPT_CHARS - 1)}…`
    : cleaned;
}
