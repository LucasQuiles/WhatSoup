// Intended repo path: tests/runtimes/agent/build-tool-update.test.ts
//
// Direct unit tests for the pure, exported `buildToolUpdate` helper in
// src/runtimes/agent/runtime.ts. This function maps an agent tool name +
// input object to a { category, detail } ToolUpdate rendered into WhatsApp
// status lines. It is a pure switch with no I/O, so it needs no mocking.
//
// Existing coverage (tests/runtimes/agent/runtime.test.ts) only exercises the
// Bash / Read / Glob / Grep cases via the heavy AgentRuntime + queue mock path,
// leaving ~51/75 branches uncovered: Edit/Write, Agent, WebFetch, WebSearch,
// Skill, TodoWrite, TaskCreate/Update/List/Get, ToolSearch, LS, Notebook*,
// LSP, Enter/ExitPlanMode, SendMessage, AskUserQuestion, the MCP default
// branch (incl. the knowledge_search friendly label), and the shortPath /
// trunc helper edge cases. These tests target those branches directly.

import { describe, it, expect } from 'vitest';
import { buildToolUpdate } from '../../../src/runtimes/agent/runtime.ts';

describe('buildToolUpdate — file tools', () => {
  it('Read without limit/offset omits the line range', () => {
    const u = buildToolUpdate('Read', { file_path: 'src/main.ts' });
    expect(u.category).toBe('reading');
    expect(u.detail).toBe('`src/main.ts`');
    expect(u.detail).not.toContain('L');
  });

  it('Read with only offset still renders a range (endLine "?")', () => {
    const u = buildToolUpdate('Read', { file_path: 'src/main.ts', offset: 20 });
    expect(u.category).toBe('reading');
    expect(u.detail).toContain('L20');
    expect(u.detail).toContain('L?');
  });

  it('Edit reports the modifying category with backticked path', () => {
    const u = buildToolUpdate('Edit', { file_path: 'src/a.ts' });
    expect(u).toEqual({ category: 'modifying', detail: '`src/a.ts`' });
  });

  it('Write shares the Edit branch', () => {
    const u = buildToolUpdate('Write', { file_path: 'src/b.ts' });
    expect(u).toEqual({ category: 'modifying', detail: '`src/b.ts`' });
  });

  it('LS defaults the path to "." when absent', () => {
    const u = buildToolUpdate('LS', {});
    expect(u).toEqual({ category: 'reading', detail: '`.`' });
  });

  it('LS uses the provided path', () => {
    const u = buildToolUpdate('LS', { path: 'src/runtimes' });
    expect(u).toEqual({ category: 'reading', detail: '`src/runtimes`' });
  });

  it('NotebookEdit and NotebookRead both map to modifying', () => {
    expect(buildToolUpdate('NotebookEdit', { notebook: 'a.ipynb' })).toEqual({
      category: 'modifying',
      detail: '`a.ipynb`',
    });
    expect(buildToolUpdate('NotebookRead', { notebook: 'b.ipynb' })).toEqual({
      category: 'modifying',
      detail: '`b.ipynb`',
    });
  });
});

describe('buildToolUpdate — search tools', () => {
  it('Glob without a scope renders a single-line pattern', () => {
    const u = buildToolUpdate('Glob', { pattern: '**/*.ts' });
    expect(u.category).toBe('searching');
    expect(u.detail).toBe('`**/*.ts`');
    expect(u.detail).not.toContain('\n→');
  });

  it('Grep falls back to `path` when `glob` is absent', () => {
    const u = buildToolUpdate('Grep', { pattern: 'foo', path: 'src' });
    expect(u.category).toBe('searching');
    expect(u.detail).toContain('`foo`');
    expect(u.detail).toContain('\n→ `src`');
  });

  it('Grep without any scope is single-line', () => {
    const u = buildToolUpdate('Grep', { pattern: 'foo' });
    expect(u).toEqual({ category: 'searching', detail: '`foo`' });
  });

  it('LSP uses the command, defaulting to a label', () => {
    expect(buildToolUpdate('LSP', { command: 'references' })).toEqual({
      category: 'searching',
      detail: 'references',
    });
    expect(buildToolUpdate('LSP', {})).toEqual({
      category: 'searching',
      detail: 'language server',
    });
  });
});

describe('buildToolUpdate — agent + remote tools', () => {
  it('Agent humanizes subagent_type and appends the description', () => {
    const u = buildToolUpdate('Agent', {
      subagent_type: 'code-explorer',
      description: 'trace the path',
    });
    expect(u.category).toBe('agent');
    expect(u.detail).toBe('code explorer: trace the path');
  });

  it('Agent defaults the label to "agent" and falls back to the prompt', () => {
    const u = buildToolUpdate('Agent', { prompt: 'do the thing' });
    expect(u.category).toBe('agent');
    expect(u.detail).toBe('agent: do the thing');
  });

  it('SendMessage renders an arrow to the recipient', () => {
    expect(buildToolUpdate('SendMessage', { to: 'Bob' })).toEqual({
      category: 'agent',
      detail: '→ Bob',
    });
  });

  it('WebFetch strips the scheme and query string', () => {
    const u = buildToolUpdate('WebFetch', {
      url: 'https://example.com/page?token=secret',
    });
    expect(u.category).toBe('fetching');
    expect(u.detail).toBe('`example.com/page`');
  });

  it('WebSearch backticks the query', () => {
    expect(buildToolUpdate('WebSearch', { query: 'best soup' })).toEqual({
      category: 'fetching',
      detail: '`best soup`',
    });
  });
});

describe('buildToolUpdate — skill / planning tools', () => {
  it('Skill uses the skill name, defaulting to "skill"', () => {
    expect(buildToolUpdate('Skill', { skill: 'verify' })).toEqual({
      category: 'skill',
      detail: '`verify`',
    });
    expect(buildToolUpdate('Skill', {})).toEqual({
      category: 'skill',
      detail: '`skill`',
    });
  });

  it('ToolSearch uses the query, defaulting to "tools"', () => {
    expect(buildToolUpdate('ToolSearch', { query: 'send slack' })).toEqual({
      category: 'skill',
      detail: '`send slack`',
    });
    expect(buildToolUpdate('ToolSearch', {})).toEqual({
      category: 'skill',
      detail: '`tools`',
    });
  });

  it('TodoWrite reports a fixed status', () => {
    expect(buildToolUpdate('TodoWrite', {})).toEqual({
      category: 'planning',
      detail: 'Updating todos',
    });
  });

  it('TaskCreate uses the subject, defaulting to a label', () => {
    expect(buildToolUpdate('TaskCreate', { subject: 'Ship it' })).toEqual({
      category: 'planning',
      detail: 'Ship it',
    });
    expect(buildToolUpdate('TaskCreate', {})).toEqual({
      category: 'planning',
      detail: 'Creating task',
    });
  });

  it('TaskUpdate embeds the task id', () => {
    expect(buildToolUpdate('TaskUpdate', { taskId: 'T-9' })).toEqual({
      category: 'planning',
      detail: 'Updating task T-9',
    });
  });

  it('TaskList and TaskGet both report "Checking tasks"', () => {
    expect(buildToolUpdate('TaskList', {})).toEqual({
      category: 'planning',
      detail: 'Checking tasks',
    });
    expect(buildToolUpdate('TaskGet', {})).toEqual({
      category: 'planning',
      detail: 'Checking tasks',
    });
  });

  it('EnterPlanMode and ExitPlanMode produce distinct planning details', () => {
    expect(buildToolUpdate('EnterPlanMode', {})).toEqual({
      category: 'planning',
      detail: 'Planning',
    });
    expect(buildToolUpdate('ExitPlanMode', {})).toEqual({
      category: 'planning',
      detail: 'Executing plan',
    });
  });

  it('AskUserQuestion is a fixed "other" prompt', () => {
    expect(buildToolUpdate('AskUserQuestion', {})).toEqual({
      category: 'other',
      detail: 'Asking a question',
    });
  });
});

describe('buildToolUpdate — MCP default branch', () => {
  it('renders a friendly label for the knowledge_search MCP tool with a query', () => {
    const u = buildToolUpdate('mcp__memory__knowledge_search', { query: 'soup' });
    expect(u).toEqual({
      category: 'searching',
      detail: 'Checking my notes on soup',
    });
  });

  it('renders the generic knowledge_search label when no query is present', () => {
    const u = buildToolUpdate('mcp__memory__knowledge_search', {});
    expect(u).toEqual({
      category: 'searching',
      detail: 'Checking my notes',
    });
  });

  it('humanizes a generic MCP tool name by replacing separators', () => {
    const u = buildToolUpdate('mcp__github__create_pull-request', {});
    expect(u.category).toBe('other');
    expect(u.detail).toBe('`create pull request`');
  });

  it('falls back to the raw tool name for unknown non-MCP tools', () => {
    const u = buildToolUpdate('SomethingNovel', {});
    expect(u).toEqual({ category: 'other', detail: '`SomethingNovel`' });
  });
});

describe('buildToolUpdate — shortPath and trunc helpers', () => {
  it('strips a /home/<user>/ prefix to ~/', () => {
    const u = buildToolUpdate('Edit', { file_path: '/home/testuser/notes.txt' });
    expect(u.detail).toBe('`~/notes.txt`');
  });

  it('strips a /Users/<user>/ prefix like /home to ~/', () => {
    const u = buildToolUpdate('Edit', { file_path: '/Users/testuser/notes.txt' });
    expect(u.detail).toBe('`~/notes.txt`');
  });

  it('strips a ~/LAB/<project>/ prefix entirely (via the /home + LAB rewrite)', () => {
    const u = buildToolUpdate('Edit', {
      file_path: '/home/testuser/LAB/WhatSoup/src/runtimes/agent/runtime.ts',
    });
    // /home/testuser/ -> ~/  then  ~/LAB/WhatSoup/ -> ''
    expect(u.detail).toBe('`src/runtimes/agent/runtime.ts`');
  });

  it('middle-truncates a path longer than 80 chars with an ellipsis', () => {
    const longSegment = 'a'.repeat(120);
    const u = buildToolUpdate('Edit', { file_path: longSegment });
    // detail is `<truncated>` — strip the surrounding backticks
    const inner = u.detail.slice(1, -1);
    expect(inner.length).toBe(80);
    expect(inner).toContain('…');
    expect(inner.startsWith('a'.repeat(38))).toBe(true);
  });

  it('end-truncates a long Bash description to 160 chars with an ellipsis', () => {
    const desc = 'x'.repeat(200);
    const u = buildToolUpdate('Bash', { description: desc });
    expect(u.category).toBe('running');
    expect(u.detail.length).toBe(160);
    expect(u.detail.endsWith('…')).toBe(true);
  });

  it('Bash with no description falls back to the first non-blank command line', () => {
    const u = buildToolUpdate('Bash', { command: '\n   \nls -la\nrm x' });
    expect(u).toEqual({ category: 'running', detail: '`ls -la`' });
  });

  it('Bash with an all-blank command falls back to the raw command', () => {
    // .find() returns undefined → falls back to str('command')
    const u = buildToolUpdate('Bash', { command: '   ' });
    expect(u).toEqual({ category: 'running', detail: '`   `' });
  });

  it('coerces missing string inputs to empty strings (no throw on undefined)', () => {
    const u = buildToolUpdate('WebSearch', {});
    expect(u).toEqual({ category: 'fetching', detail: '``' });
  });
});
