/**
 * Direct unit coverage for src/runtimes/agent/providers/tool-mapping.ts.
 *
 * The module exposes 4 ToolNameMapper instances (claude/codex/gemini/default)
 * plus a `getToolMapper(providerId)` selector. Each mapper exposes
 * `mapToolName(name) → ToolCategory` and `getToolLabel(name, input) → string`.
 *
 * No direct test mirror existed. Existing tests reference it only indirectly
 * via the agent runtime suite. This file pins per-mapper category mappings,
 * fallback behavior, label formatting, and selector dispatch.
 */
import { describe, expect, it } from 'vitest';
import {
  claudeToolMapper,
  codexToolMapper,
  geminiToolMapper,
  defaultToolMapper,
  getToolMapper,
  type ToolCategory,
} from '../../../../src/runtimes/agent/providers/tool-mapping.ts';

describe('claudeToolMapper.mapToolName', () => {
  const knownToolCategories: Array<[string, ToolCategory]> = [
    ['Read', 'reading'],
    ['LS', 'reading'],
    ['Edit', 'modifying'],
    ['Write', 'modifying'],
    ['NotebookEdit', 'modifying'],
    ['NotebookRead', 'modifying'],
    ['Bash', 'running'],
    ['Glob', 'searching'],
    ['Grep', 'searching'],
    ['LSP', 'searching'],
    ['WebFetch', 'fetching'],
    ['WebSearch', 'fetching'],
    ['Agent', 'agent'],
    ['SendMessage', 'agent'],
    ['Skill', 'skill'],
    ['ToolSearch', 'skill'],
    ['TodoWrite', 'planning'],
    ['TaskCreate', 'planning'],
    ['TaskUpdate', 'planning'],
    ['TaskList', 'planning'],
    ['TaskGet', 'planning'],
    ['EnterPlanMode', 'planning'],
    ['ExitPlanMode', 'planning'],
  ];

  it.each(knownToolCategories)('maps "%s" to category "%s"', (toolName, expected) => {
    expect(claudeToolMapper.mapToolName(toolName)).toBe(expected);
  });

  it('falls back to "other" for unknown tool names', () => {
    expect(claudeToolMapper.mapToolName('SomeUnknownTool')).toBe('other');
    expect(claudeToolMapper.mapToolName('')).toBe('other');
  });
});

describe('claudeToolMapper.getToolLabel', () => {
  it('formats Read with file_path basename', () => {
    expect(claudeToolMapper.getToolLabel('Read', { file_path: '/a/b/c/file.ts' })).toBe(
      'Reading file.ts',
    );
  });

  it('returns "Running command" for Bash with a command', () => {
    expect(claudeToolMapper.getToolLabel('Bash', { command: 'ls -la' })).toBe('Running command');
  });

  it('formats Grep with the pattern echoed back', () => {
    expect(claudeToolMapper.getToolLabel('Grep', { pattern: 'foo' })).toBe('Searching for foo');
  });

  it('falls back to the toolName itself when no special-case matches', () => {
    expect(claudeToolMapper.getToolLabel('UnknownTool', {})).toBe('UnknownTool');
    expect(claudeToolMapper.getToolLabel('Bash', {})).toBe('Bash'); // no command → fallback
  });
});

describe('codexToolMapper.mapToolName', () => {
  const knownCodexTools: Array<[string, ToolCategory]> = [
    ['command_execution', 'running'],
    ['file_change', 'modifying'],
    ['file_read', 'reading'],
    ['mcp_tool_call', 'other'],
    ['web_search', 'fetching'],
  ];

  it.each(knownCodexTools)('maps "%s" to category "%s"', (toolName, expected) => {
    expect(codexToolMapper.mapToolName(toolName)).toBe(expected);
  });

  it('falls back to "other" for unknown', () => {
    expect(codexToolMapper.mapToolName('mystery')).toBe('other');
  });
});

describe('codexToolMapper.getToolLabel', () => {
  it('returns "Running command" for command_execution with a command', () => {
    expect(codexToolMapper.getToolLabel('command_execution', { command: 'ls' })).toBe(
      'Running command',
    );
  });

  it('returns "Modifying file" for file_change', () => {
    expect(codexToolMapper.getToolLabel('file_change', {})).toBe('Modifying file');
  });

  it('falls back to toolName for unknown tools', () => {
    expect(codexToolMapper.getToolLabel('other', {})).toBe('other');
  });
});

describe('geminiToolMapper.mapToolName', () => {
  const knownGeminiTools: Array<[string, ToolCategory]> = [
    ['read_file', 'reading'],
    ['edit_file', 'modifying'],
    ['write_new_file', 'modifying'],
    ['run_shell_command', 'running'],
    ['grep', 'searching'],
    ['glob', 'searching'],
    ['list_directory', 'searching'],
    ['google_web_search', 'fetching'],
  ];

  it.each(knownGeminiTools)('maps "%s" to category "%s"', (toolName, expected) => {
    expect(geminiToolMapper.mapToolName(toolName)).toBe(expected);
  });

  it('falls back to "other" for unknown', () => {
    expect(geminiToolMapper.mapToolName('unknown_tool')).toBe('other');
  });
});

describe('geminiToolMapper.getToolLabel', () => {
  it('replaces underscores with spaces in the tool name', () => {
    expect(geminiToolMapper.getToolLabel('run_shell_command', {})).toBe('run shell command');
    expect(geminiToolMapper.getToolLabel('google_web_search', {})).toBe('google web search');
  });

  it('passes through names without underscores unchanged', () => {
    expect(geminiToolMapper.getToolLabel('grep', {})).toBe('grep');
  });
});

describe('defaultToolMapper.mapToolName (heuristic substring matching)', () => {
  it.each<[string, ToolCategory]>([
    ['readFile', 'reading'],
    ['list_items', 'reading'],
    ['getStatus', 'reading'],
    ['writeFile', 'modifying'],
    ['editLine', 'modifying'],
    ['create_dir', 'modifying'],
    ['updateRecord', 'modifying'],
    ['send_message', 'modifying'],
    ['runBash', 'running'],
    ['exec_script', 'running'],
    ['bash_runner', 'running'],
    ['search_index', 'searching'],
    ['grepLines', 'searching'],
    ['find_files', 'searching'],
    ['fetch_url', 'fetching'],
    ['web_lookup', 'fetching'],
  ])('"%s" → "%s" via heuristic match', (toolName, expected) => {
    expect(defaultToolMapper.mapToolName(toolName)).toBe(expected);
  });

  it('returns "other" when no heuristic matches', () => {
    expect(defaultToolMapper.mapToolName('mystery_action')).toBe('other');
    expect(defaultToolMapper.mapToolName('zzz')).toBe('other');
  });

  it('matching is case-insensitive (uppercase keywords still match)', () => {
    expect(defaultToolMapper.mapToolName('READ_USER')).toBe('reading');
    expect(defaultToolMapper.mapToolName('SEND_EMAIL')).toBe('modifying');
  });
});

describe('defaultToolMapper.getToolLabel', () => {
  it('strips mcp__<provider>__ prefix and replaces underscores', () => {
    expect(defaultToolMapper.getToolLabel('mcp__google_drive__list_files', {})).toBe('list files');
  });

  it('replaces remaining underscores even without prefix', () => {
    expect(defaultToolMapper.getToolLabel('some_other_tool', {})).toBe('some other tool');
  });

  it('passes through names with neither prefix nor underscores unchanged', () => {
    expect(defaultToolMapper.getToolLabel('Plain', {})).toBe('Plain');
  });
});

describe('getToolMapper selector', () => {
  it('returns claudeToolMapper for "claude-cli"', () => {
    expect(getToolMapper('claude-cli')).toBe(claudeToolMapper);
  });

  it('returns codexToolMapper for "codex-cli"', () => {
    expect(getToolMapper('codex-cli')).toBe(codexToolMapper);
  });

  it('returns geminiToolMapper for "gemini-cli"', () => {
    expect(getToolMapper('gemini-cli')).toBe(geminiToolMapper);
  });

  it('returns defaultToolMapper for unknown providers (fallback)', () => {
    expect(getToolMapper('anthropic-api')).toBe(defaultToolMapper);
    expect(getToolMapper('openai-api')).toBe(defaultToolMapper);
    expect(getToolMapper('made-up-provider')).toBe(defaultToolMapper);
    expect(getToolMapper('')).toBe(defaultToolMapper);
  });
});
