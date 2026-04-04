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

const claudeToolCategories: Record<string, ToolCategory> = {
  Read: 'reading',
  LS: 'reading',
  Edit: 'modifying',
  Write: 'modifying',
  NotebookEdit: 'modifying',
  NotebookRead: 'modifying',
  Bash: 'running',
  Glob: 'searching',
  Grep: 'searching',
  LSP: 'searching',
  WebFetch: 'fetching',
  WebSearch: 'fetching',
  Agent: 'agent',
  SendMessage: 'agent',
  Skill: 'skill',
  ToolSearch: 'skill',
  TodoWrite: 'planning',
  TaskCreate: 'planning',
  TaskUpdate: 'planning',
  TaskList: 'planning',
  TaskGet: 'planning',
  EnterPlanMode: 'planning',
  ExitPlanMode: 'planning',
};

export const claudeToolMapper: ToolNameMapper = {
  mapToolName(toolName: string): ToolCategory {
    return claudeToolCategories[toolName] ?? 'other';
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

const codexToolCategories: Record<string, ToolCategory> = {
  command_execution: 'running',
  file_change: 'modifying',
  file_read: 'reading',
  mcp_tool_call: 'other',
  web_search: 'fetching',
};

export const codexToolMapper: ToolNameMapper = {
  mapToolName(toolName: string): ToolCategory {
    return codexToolCategories[toolName] ?? 'other';
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

const geminiToolCategories: Record<string, ToolCategory> = {
  read_file: 'reading',
  edit_file: 'modifying',
  write_new_file: 'modifying',
  run_shell_command: 'running',
  grep: 'searching',
  glob: 'searching',
  list_directory: 'searching',
  google_web_search: 'fetching',
};

export const geminiToolMapper: ToolNameMapper = {
  mapToolName(toolName: string): ToolCategory {
    return geminiToolCategories[toolName] ?? 'other';
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
