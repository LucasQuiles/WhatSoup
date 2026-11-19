/**
 * Config-load coverage for the sandboxPerChat instructionsPath rule in
 * src/core/agent-config-validator.ts: a relative path that a sandboxPerChat
 * session reads from its chat workspace must stay lexically inside it. The
 * other instructionsPath cases stay in agent-config-validator.test.ts; this
 * case keeps that file's describe name, helpers and fixtures.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateInstanceConfig,
  type ValidatorContext,
} from '../../src/core/agent-config-validator.ts';

const baseAgent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'alpha',
  type: 'agent',
  accessMode: 'self_only',
  adminPhones: ['15551234567'],
  agentOptions: { sessionScope: 'single' },
  ...overrides,
});

const ctx = (mode: ValidatorContext['mode'], over: Partial<ValidatorContext> = {}): ValidatorContext => ({
  name: 'alpha',
  mode,
  ...over,
});

describe('agent type rules', () => {
  it('refuses a sandboxPerChat relative instructionsPath that is not lexically inside the chat workspace', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-validator-home-'));
    const cwd = path.join(home, 'workspace');
    fs.mkdirSync(path.join(cwd, 'notes'), { recursive: true });
    // Readable files inside home, so only the chat-workspace rule refuses a path that reaches them.
    fs.writeFileSync(path.join(home, 'x.md'), 'instructions\n');
    fs.writeFileSync(path.join(cwd, 'x.md'), 'instructions\n');
    fs.writeFileSync(path.join(cwd, 'notes', 'agent.md'), 'instructions\n');
    const live = { ...ctx('load'), filesystem: { homeDirectory: home } };
    const config = (instructionsPath: string, sandboxPerChat = true) => baseAgent({
      agentOptions: { sessionScope: 'per_chat', ...(sandboxPerChat ? { sandboxPerChat } : {}), cwd, instructionsPath } });
    try {
      // `..` segments, then forms that path.normalize would change. The rule is lexical, so it needs no filesystem.
      for (const outside of ['../x.md', 'notes/../../x.md', './../x.md', 'notes/..', './x.md', 'notes//agent.md', 'notes/./agent.md']) {
        for (const context of [live, ctx('load')]) {
          const result = validateInstanceConfig(config(outside), context);
          expect(result?.field, outside).toBe('agentOptions.instructionsPath');
          expect(result?.message, outside).toContain('chat workspace');
        }
      }
      // Unchanged: a confined path is left to the session, CLAUDE.md is checked at load,
      // and without sandboxPerChat a `..` path that stays inside home is accepted.
      expect(validateInstanceConfig(config('notes/agent.md'), live)).toBeNull();
      expect(validateInstanceConfig(config('CLAUDE.md'), live)?.field).toBe('agentOptions.instructionsPath');
      fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'instructions\n');
      expect(validateInstanceConfig(config('CLAUDE.md'), live)).toBeNull();
      expect(validateInstanceConfig(config('../x.md', false), live)).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
