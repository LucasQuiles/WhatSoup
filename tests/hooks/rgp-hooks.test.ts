import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STOP_HOOK = join(process.cwd(), 'deploy/hooks/stop-ensure-reply.mjs');
const POST_TOOL_HOOK = join(process.cwd(), 'deploy/hooks/post-tool-use-log.mjs');
const AWS_KEY_SAMPLE = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB_TOKEN_SAMPLE = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
const JWT_SAMPLE = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjMifQ', 'signaturepart1234567890'].join('.');
const PRIVATE_KEY_SAMPLE = ['-----BEGIN ', 'PRIVATE KEY-----', '\nabc\n', '-----END ', 'PRIVATE KEY-----'].join('');
const URL_USERINFO_SAMPLE = `https://user:pass@${'example'}.com/path`;
const REDACTED_URL_USERINFO = `https://[REDACTED]@${'example'}.com/path`;

const tmpDirs: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rgp-hooks-home-'));
  tmpDirs.push(dir);
  return dir;
}

function writeTranscript(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'rgp-hooks-transcript-'));
  tmpDirs.push(dir);
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return path;
}

function runNodeHook(script: string, payload: unknown, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

function queuePath(home: string, instance = 'ana-bot'): string {
  return join(home, '.claude', 'rgp', instance, 'stuck-replies.jsonl');
}

function errorsPath(home: string, sessionId: string): string {
  return join(home, '.claude', 'session-env', sessionId, 'errors.jsonl');
}

function botErrorsOutbox(home: string): string {
  return join(home, '.local', 'state', 'bot-errors', 'outbox');
}

function markerPath(home: string, sessionId: string): string {
  return join(home, '.claude', 'session-env', sessionId, 'whatsapp-fallback-queued');
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readBotErrors(home: string): unknown[] {
  const outbox = botErrorsOutbox(home);
  if (!existsSync(outbox)) return [];
  return readdirSync(outbox)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map((name) => JSON.parse(readFileSync(join(outbox, name), 'utf8')));
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe('PostToolUse RGP error logger', () => {
  it('records tool errors as bounded session JSONL without blocking the hook path', () => {
    const home = makeHome();

    const result = runNodeHook(POST_TOOL_HOOK, {
      session_id: 'session-a',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test -- --runInBand' },
      tool_response: {
        is_error: true,
        content: 'sandbox_deny: /private/tmp/whatsoup/private +1 (415) 555-1212 failed',
      },
    }, { HOME: home, WHATSOUP_INSTANCE: 'ana-bot' });

    expect(result.status).toBe(0);
    const entries = readJsonl(errorsPath(home, 'session-a'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'tool-error',
      sessionId: 'session-a',
      toolName: 'Bash',
      inputSummary: 'npm test -- --runInBand',
    });
    expect(JSON.stringify(entries[0])).toContain('<redacted-path>');
    expect(JSON.stringify(entries[0])).toContain('<redacted-phone>');
    expect(JSON.stringify(entries[0])).not.toContain('/private/tmp');
    expect(JSON.stringify(entries[0])).not.toContain('415');
    expect(readBotErrors(home)).toHaveLength(0);
  });

  it('does not log successful tool responses and truncates oversized error logs', () => {
    const home = makeHome();
    const path = errorsPath(home, 'session-b');
    mkdirSync(join(home, '.claude', 'session-env', 'session-b'), { recursive: true });
    writeFileSync(path, Array.from({ length: 250 }, (_, i) => JSON.stringify({
      event: 'tool-error',
      sessionId: 'session-b',
      toolName: 'Bash',
      excerpt: `old-${i}-${'x'.repeat(400)}`,
    })).join('\n'));

    const ok = runNodeHook(POST_TOOL_HOOK, {
      session_id: 'session-b',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { is_error: false, content: 'ok' },
    }, { HOME: home });

    expect(ok.status).toBe(0);

    const error = runNodeHook(POST_TOOL_HOOK, {
      session_id: 'session-b',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/missing' },
      tool_response: { error: 'ENOENT: no such file' },
    }, { HOME: home });

    expect(error.status).toBe(0);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      event: 'tool-error',
      sessionId: 'session-b',
      toolName: 'Read',
    });
    expect(readBotErrors(home)).toHaveLength(0);
  });

  it('queues BOT ERRORS alerts from PostToolUseFailure payloads', () => {
    const home = makeHome();

    const result = runNodeHook(POST_TOOL_HOOK, {
      session_id: 'session-fail',
      hook_event_name: 'PostToolUseFailure',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/workspace',
      tool_name: 'Bash',
      tool_use_id: 'tool-123',
      tool_input: { command: 'python3 -c "raise SystemExit(2)"' },
      error: [
        'Command timed out after 120000ms token=plain-secret',
        AWS_KEY_SAMPLE,
        GITHUB_TOKEN_SAMPLE,
        JWT_SAMPLE,
        PRIVATE_KEY_SAMPLE,
        URL_USERINFO_SAMPLE,
      ].join('\n'),
      duration_ms: 120000,
    }, { HOME: home, WHATSOUP_INSTANCE: 'ana-bot', WHATSOUP_CHAT_JID: 'chat@g.us' });

    expect(result.status).toBe(0);
    const botErrors = readBotErrors(home);
    expect(botErrors).toHaveLength(1);
    expect(botErrors[0]).toMatchObject({
      eventType: 'alert',
      severity: 'error',
      instance: 'ana-bot',
      source: 'hook-tool-call-failed:Bash',
      summary: 'Agent tool failure: Bash',
    });
    expect(JSON.stringify(botErrors[0])).toContain('duration_ms=120000');
    expect(JSON.stringify(botErrors[0])).toContain('tool_use_id=tool-123');
    expect(JSON.stringify(botErrors[0])).toContain('token=[REDACTED]');
    expect(JSON.stringify(botErrors[0])).toContain('[REDACTED AWS ACCESS KEY]');
    expect(JSON.stringify(botErrors[0])).toContain('[REDACTED GITHUB TOKEN]');
    expect(JSON.stringify(botErrors[0])).toContain('[REDACTED JWT]');
    expect(JSON.stringify(botErrors[0])).toContain('[REDACTED PEM PRIVATE KEY]');
    expect(JSON.stringify(botErrors[0])).toContain(REDACTED_URL_USERINFO);
    expect(JSON.stringify(botErrors[0])).not.toContain('plain-secret');
    expect(JSON.stringify(botErrors[0])).not.toContain(AWS_KEY_SAMPLE);
    expect(JSON.stringify(botErrors[0])).not.toContain(GITHUB_TOKEN_SAMPLE);
    expect(JSON.stringify(botErrors[0])).not.toContain('eyJhbGci');
    expect(JSON.stringify(botErrors[0])).not.toContain('-----BEGIN');
    expect(JSON.stringify(botErrors[0])).not.toContain(URL_USERINFO_SAMPLE);
  });
});

describe('Stop RGP stuck-reply hook', () => {
  it('does not enqueue when the transcript already has a visible reply', () => {
    const home = makeHome();
    const transcriptPath = writeTranscript([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Need an update.' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The update is ready.' }] } },
    ]);

    const result = runNodeHook(STOP_HOOK, {
      session_id: 'session-c',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
    }, {
      HOME: home,
      WHATSOUP_CHAT_JID: 'chat@g.us',
      WHATSOUP_INSTANCE: 'ana-bot',
    });

    expect(result.status).toBe(0);
    expect(readJsonl(queuePath(home))).toEqual([]);
    expect(existsSync(markerPath(home, 'session-c'))).toBe(false);
  });

  it('enqueues a stuck-reply intent with the latest tool-error breadcrumb and deduplicates by session', () => {
    const home = makeHome();
    const transcriptPath = writeTranscript([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Please send the answer.' }] } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'send-1', name: 'mcp__whatsoup__send_message', input: {} }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'send-1', is_error: true, content: 'send failed' }],
        },
      },
    ]);

    runNodeHook(POST_TOOL_HOOK, {
      session_id: 'session-d',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__whatsoup__send_message',
      tool_input: { chatJid: 'chat@g.us' },
      tool_response: { is_error: true, content: 'provider rejected send' },
    }, { HOME: home });

    const payload = {
      session_id: 'session-d',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
    };
    const env = {
      HOME: home,
      WHATSOUP_CHAT_JID: 'chat@g.us',
      WHATSOUP_INSTANCE: 'ana-bot',
    };

    const first = runNodeHook(STOP_HOOK, payload, env);
    const second = runNodeHook(STOP_HOOK, payload, env);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const entries = readJsonl(queuePath(home));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'stuck-reply',
      status: 'queued',
      sessionId: 'session-d',
      chatJid: 'chat@g.us',
      instance: 'ana-bot',
    });
    expect(JSON.stringify(entries[0])).toContain('provider rejected send');
    expect(existsSync(markerPath(home, 'session-d'))).toBe(true);
  });

  it('degrades softly for non-Stop invocations and missing WhatSoup chat context', () => {
    const home = makeHome();
    const transcriptPath = writeTranscript([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    ]);

    const subagentStop = runNodeHook(STOP_HOOK, {
      session_id: 'session-e',
      hook_event_name: 'SubagentStop',
      transcript_path: transcriptPath,
    }, { HOME: home, WHATSOUP_CHAT_JID: 'chat@g.us', WHATSOUP_INSTANCE: 'ana-bot' });
    const missingContext = runNodeHook(STOP_HOOK, {
      session_id: 'session-f',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
    }, { HOME: home });

    expect(subagentStop.status).toBe(0);
    expect(missingContext.status).toBe(0);
    expect(readJsonl(queuePath(home))).toEqual([]);
  });
});
