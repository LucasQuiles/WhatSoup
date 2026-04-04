/**
 * Pluggable tool name → display category mapper per provider.
 *
 * Each provider CLI uses different tool names. This registry maps them to a
 * unified ToolCategory used by the UI layer so display logic stays provider-agnostic.
 */

export type ToolCategory =
  | 'reading'
  | 'searching'
  | 'modifying'
  | 'running'
  | 'agent'
  | 'fetching'
  | 'planning'
  | 'skill'
  | 'other'
  | 'error'
  | 'blocked'
  | 'cancelled';

export interface ToolNameMapper {
  /** Map a provider-specific tool name to a display category */
  mapToolName(toolName: string): ToolCategory;
  /** Get a human-friendly label for a tool invocation */
  getToolLabel(toolName: string, toolInput: Record<string, unknown>): string;
}

// ---------------------------------------------------------------------------
// Claude CLI mapper — extracted from runtime.ts buildToolUpdate()
// ---------------------------------------------------------------------------

export const claudeToolMapper: ToolNameMapper = {
  mapToolName(toolName: string): ToolCategory {
    switch (toolName) {
      case 'Read':
      case 'LS':
        return 'reading';

      case 'Edit':
      case 'Write':
      case 'NotebookEdit':
      case 'NotebookRead':
        return 'modifying';

      case 'Bash':
        return 'running';

      case 'Glob':
      case 'Grep':
      case 'LSP':
        return 'searching';

      case 'WebFetch':
      case 'WebSearch':
        return 'fetching';

      case 'Agent':
      case 'SendMessage':
        return 'agent';

      case 'Skill':
      case 'ToolSearch':
        return 'skill';

      case 'TodoWrite':
      case 'TaskCreate':
      case 'TaskUpdate':
      case 'TaskList':
      case 'TaskGet':
      case 'EnterPlanMode':
      case 'ExitPlanMode':
        return 'planning';

      default:
        return 'other';
    }
  },

  getToolLabel(toolName: string, toolInput: Record<string, unknown>): string {
    if (toolName === 'Read' && toolInput['file_path']) {
      const parts = (toolInput['file_path'] as string).split('/');
      return `Reading ${parts[parts.length - 1] ?? toolInput['file_path']}`;
    }
    if (toolName === 'Bash' && toolInput['command']) return 'Running command';
    if (toolName === 'Grep' && toolInput['pattern']) return `Searching for ${toolInput['pattern']}`;
    return toolName;
  },
};

// ---------------------------------------------------------------------------
// Codex CLI mapper
// ---------------------------------------------------------------------------

export const codexToolMapper: ToolNameMapper = {
  mapToolName(toolName: string): ToolCategory {
    switch (toolName) {
      case 'command_execution':
        return 'running';
      case 'file_change':
        return 'modifying';
      case 'file_read':
        return 'reading';
      case 'mcp_tool_call':
        return 'other';
      case 'web_search':
        return 'fetching';
      default:
        return 'other';
    }
  },

  getToolLabel(toolName: string, toolInput: Record<string, unknown>): string {
    if (toolName === 'command_execution' && toolInput['command']) return 'Running command';
    if (toolName === 'file_change') return 'Modifying file';
    return toolName;
  },
};

// ---------------------------------------------------------------------------
// Gemini CLI mapper
// ---------------------------------------------------------------------------

export const geminiToolMapper: ToolNameMapper = {
  mapToolName(toolName: string): ToolCategory {
    switch (toolName) {
      case 'read_file':
        return 'reading';
      case 'edit_file':
      case 'write_new_file':
        return 'modifying';
      case 'run_shell_command':
        return 'running';
      case 'grep':
      case 'glob':
      case 'list_directory':
        return 'searching';
      case 'google_web_search':
        return 'fetching';
      default:
        return 'other';
    }
  },

  getToolLabel(toolName: string, _toolInput: Record<string, unknown>): string {
    return toolName.replace(/_/g, ' ');
  },
};

// ---------------------------------------------------------------------------
// Default / fallback mapper — heuristic matching for API providers
// ---------------------------------------------------------------------------

export const defaultToolMapper: ToolNameMapper = {
  mapToolName(toolName: string): ToolCategory {
    // Strip mcp__ prefix for heuristic matching
    const lower = toolName.toLowerCase();
    if (lower.includes('read') || lower.includes('list') || lower.includes('get')) return 'reading';
    if (
      lower.includes('write') ||
      lower.includes('edit') ||
      lower.includes('create') ||
      lower.includes('update')
    )
      return 'modifying';
    if (lower.includes('bash') || lower.includes('run') || lower.includes('exec')) return 'running';
    if (lower.includes('search') || lower.includes('grep') || lower.includes('find'))
      return 'searching';
    if (lower.includes('fetch') || lower.includes('web')) return 'fetching';
    return 'other';
  },

  getToolLabel(toolName: string, _toolInput: Record<string, unknown>): string {
    return toolName.replace(/^mcp__\w+__/, '').replace(/_/g, ' ');
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const mappers: Record<string, ToolNameMapper> = {
  'claude-cli': claudeToolMapper,
  'codex-cli': codexToolMapper,
  'gemini-cli': geminiToolMapper,
};

export function getToolMapper(providerId: string): ToolNameMapper {
  return mappers[providerId] ?? defaultToolMapper;
}
