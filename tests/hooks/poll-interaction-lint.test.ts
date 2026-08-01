import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const HOOK = join(process.cwd(), 'deploy/hooks/poll-interaction-lint.mjs');
const tmp = trackTmpDirs('poll-lint-');

function runHook(payload: unknown, home: string) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

function readHookJsonl(home: string, sessionId: string): Array<{ findings?: Array<{ code: string }> }> {
  const path = join(home, '.claude', 'session-env', sessionId, 'poll-interaction-lint.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
}

describe('poll-interaction-lint hook', () => {
  it('logs a diagnostic when an agent asks the user to type a vote status', () => {
    const home = tmp.make('home');

    const result = runHook({
      session_id: 'session-a',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__whatsoup__send_message',
      tool_input: { chatJid: 'chat@g.us', text: 'Tap the poll, then type "I voted" here.' },
    }, home);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(readHookJsonl(home, 'session-a')[0].findings).toEqual([
      expect.objectContaining({ code: 'asks-user-to-type-i-voted' }),
    ]);
  });

  it('logs poll shape issues that create WhatsApp or agent-friction failures', () => {
    const home = tmp.make('home');

    const result = runHook({
      session_id: 'session-b',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__whatsoup__send_poll',
      tool_input: {
        chatJid: 'chat@g.us',
        question: '',
        options: ['Ship', ' ship ', '', 'x'.repeat(96)],
        selectableCount: 5,
      },
    }, home);

    expect(result.status).toBe(0);
    const codes = readHookJsonl(home, 'session-b')[0].findings?.map((finding) => finding.code);
    expect(codes).toEqual(expect.arrayContaining([
      'blank-poll-question',
      'duplicate-poll-option',
      'blank-poll-option',
      'long-poll-option',
      'invalid-selectable-count',
    ]));
  });

  it('does not log for a concise valid coordination poll', () => {
    const home = tmp.make('home');

    const result = runHook({
      session_id: 'session-c',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__whatsoup__send_poll',
      tool_input: {
        chatJid: 'chat@g.us',
        question: 'Which validation path should Q run next?',
        options: ['Targeted tests', 'Full release gate', 'Live E2E first'],
        selectableCount: 1,
      },
    }, home);

    expect(result.status).toBe(0);
    expect(readHookJsonl(home, 'session-c')).toEqual([]);
  });

  it('fails open on malformed hook input', () => {
    const home = tmp.make('home');

    const result = runHook('{not-json', home);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
