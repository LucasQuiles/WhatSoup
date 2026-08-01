import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const STOP_HOOK = join(process.cwd(), 'deploy/hooks/stop-ensure-reply.mjs');
const POST_TOOL_HOOK = join(process.cwd(), 'deploy/hooks/post-tool-use-log.mjs');
const AWS_KEY_SAMPLE = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB_TOKEN_SAMPLE = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
const JWT_SAMPLE = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjMifQ', 'signaturepart1234567890'].join('.');
const PRIVATE_KEY_SAMPLE = ['-----BEGIN ', 'PRIVATE KEY-----', '\nabc\n', '-----END ', 'PRIVATE KEY-----'].join('');
const URL_USERINFO_SAMPLE = `https://user:pass@${'service'}.invalid/path`;
const REDACTED_URL_USERINFO = `https://[REDACTED]@${'service'}.invalid/path`;

const tmp = trackTmpDirs('rgp-hooks-');

function testCwdHash(): string {
  return createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
}

function makeHome(): string {
  return tmp.make('home');
}

function writeTranscript(records: unknown[]): string {
  const path = join(tmp.make('transcript'), 'transcript.jsonl');
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

function readWritefails(dir: string): Record<string, any>[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.writefail'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

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
    // Assert redaction on the excerpt field, not the serialized entry — the
    // createdAt timestamp can legitimately contain any digit substring
    // (a `.415Z` millisecond once failed this as a whole-line check).
    const excerpt = String((entries[0] as { excerpt: string }).excerpt);
    expect(excerpt).toContain('<redacted-path>');
    expect(excerpt).toContain('<redacted-phone>');
    expect(excerpt).not.toContain('/private/tmp');
    expect(excerpt).not.toContain('415');
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
    }, {
      HOME: home,
      BOT_ERRORS_STATE_DIR: join(home, '.local', 'state', 'bot-errors'),
      BOT_ERRORS_ALLOW_TEST_LIVE_OUTBOX: '1',
      WHATSOUP_INSTANCE: 'ana-bot',
      WHATSOUP_CHAT_JID: 'chat@g.us',
    });

    expect(result.status).toBe(0);
    const botErrors = readBotErrors(home);
    expect(botErrors).toHaveLength(1);
    expect(botErrors[0]).toMatchObject({
      schemaVersion: 2,
      eventKind: 'incident_alert',
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

  it('keeps unconfigured Vitest hook alerts out of the real home outbox', () => {
    const home = makeHome();
    const temp = tmp.make('vitest-state');

    const result = runNodeHook(POST_TOOL_HOOK, {
      session_id: 'session-vitest-default',
      hook_event_name: 'PostToolUseFailure',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/workspace',
      tool_name: 'Bash',
      tool_use_id: 'tool-123',
      tool_input: { command: 'exit 2' },
      error: 'Command failed',
      duration_ms: 1234,
    }, {
      HOME: home,
      TMPDIR: temp,
      NODE_ENV: 'test',
      VITEST: 'true',
      VITEST_WORKER_ID: 'hook-worker',
      BOT_ERRORS_STATE_DIR: '',
      BOT_ERRORS_OUTBOX_DIR: '',
      WHATSOUP_INSTANCE: 'ana-bot',
      WHATSOUP_CHAT_JID: 'chat@g.us',
    });

    expect(result.status).toBe(0);
    expect(readBotErrors(home)).toHaveLength(0);
    expect(readdirSync(join(temp, 'whatsoup-vitest-bot-errors', `${testCwdHash()}.hook-worker`, 'outbox')).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  });

  it('redirects an explicit live hook outbox under strong test provenance', () => {
    const home = makeHome();
    const temp = tmp.make('vitest-live');
    const liveOutbox = botErrorsOutbox(home);

    const result = runNodeHook(POST_TOOL_HOOK, {
      session_id: 'session-vitest-live',
      hook_event_name: 'PostToolUseFailure',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/workspace',
      tool_name: 'Bash',
      tool_use_id: 'tool-123',
      tool_input: { command: 'exit 2' },
      error: 'Command failed',
      duration_ms: 1234,
    }, {
      HOME: home,
      TMPDIR: temp,
      NODE_ENV: 'test',
      VITEST: 'true',
      VITEST_WORKER_ID: 'hook-live-worker',
      BOT_ERRORS_OUTBOX_DIR: liveOutbox,
      WHATSOUP_INSTANCE: 'ana-bot',
    });

    expect(result.status).toBe(0);
    expect(readBotErrors(home)).toHaveLength(0);
    const testOutbox = join(temp, 'whatsoup-vitest-bot-errors', `${testCwdHash()}.hook-live-worker`, 'outbox');
    const events = readdirSync(testOutbox)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(join(testOutbox, file), 'utf8')) as Record<string, any>);
    expect(events).toHaveLength(1);
    expect(events[0]?.runtime.provenance).toMatchObject({
      producer: 'post-tool-use-hook',
      test: true,
      outboxPolicy: 'test-redirect',
      liveOutboxRedirected: true,
    });
  });

  it('records a recoverable writefail breadcrumb when the BOT ERRORS outbox is unwritable', () => {
    const home = makeHome();
    const writefail = join(home, 'writefail-override');

    const result = runNodeHook(POST_TOOL_HOOK, {
      session_id: 'session-outbox-fail',
      hook_event_name: 'PostToolUseFailure',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/workspace',
      tool_name: 'Bash',
      tool_use_id: 'tool-123',
      tool_input: { command: ['curl https://user:pass', 'service.invalid token=plain-secret'].join('@') },
      error: [
        'Command failed token=plain-secret',
        AWS_KEY_SAMPLE,
        GITHUB_TOKEN_SAMPLE,
      ].join('\n'),
      duration_ms: 1234,
    }, {
      HOME: home,
      BOT_ERRORS_OUTBOX_DIR: '/dev/null/outbox',
      BOT_ERRORS_WRITEFAIL_DIR: writefail,
      WHATSOUP_INSTANCE: 'ana-bot',
      WHATSOUP_CHAT_JID: 'chat@g.us',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('CRITICAL outbox write FAILED');
    expect(result.stderr).toContain('lost-alert breadcrumb written');
    expect(readBotErrors(home)).toHaveLength(0);
    const crumbs = readWritefails(writefail);
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({ kind: 'outbox_write_failure', schemaVersion: 1 });
    expect(crumbs[0].event).toMatchObject({
      schemaVersion: 2,
      eventKind: 'incident_alert',
      eventType: 'alert',
      severity: 'error',
      instance: 'ana-bot',
      source: 'hook-tool-call-failed:Bash',
      summary: 'Agent tool failure: Bash',
    });
    expect(JSON.stringify(crumbs[0])).toContain('token=[REDACTED]');
    expect(JSON.stringify(crumbs[0])).toContain('[REDACTED AWS ACCESS KEY]');
    expect(JSON.stringify(crumbs[0])).toContain('[REDACTED GITHUB TOKEN]');
    expect(JSON.stringify(crumbs[0])).not.toContain('plain-secret');
    expect(JSON.stringify(crumbs[0])).not.toContain(AWS_KEY_SAMPLE);
    expect(JSON.stringify(crumbs[0])).not.toContain(GITHUB_TOKEN_SAMPLE);
    expect(readJsonl(errorsPath(home, 'session-outbox-fail')).at(-1)).toMatchObject({
      event: 'bot-errors-alert-failed',
    });
  });

  it('uses HOME writefail fallback before TMPDIR when override and state writefail dirs are blocked', () => {
    const root = tmp.make('writefail-fallback');
    const blockedOverride = join(root, 'blocked-override');
    const stateRoot = join(root, 'state');
    const home = join(root, 'home');
    const writerTmp = join(root, 'writer-tmp');
    writeFileSync(blockedOverride, 'not a directory');
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(writerTmp, { recursive: true });
    writeFileSync(join(stateRoot, 'writefail'), 'not a directory');

    const result = runNodeHook(POST_TOOL_HOOK, {
      session_id: 'session-home-fallback',
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'tool-123',
      error: 'Command failed token=plain-secret',
    }, {
      HOME: home,
      TMPDIR: writerTmp,
      BOT_ERRORS_OUTBOX_DIR: '/dev/null/outbox',
      BOT_ERRORS_WRITEFAIL_DIR: join(blockedOverride, 'writefail'),
      BOT_ERRORS_STATE_DIR: stateRoot,
      WHATSOUP_INSTANCE: 'ana-bot',
    });

    expect(result.status).toBe(0);
    expect(readWritefails(join(home, '.bot-errors-writefail'))).toHaveLength(1);
    expect(readWritefails(join(writerTmp, 'bot-errors-writefail'))).toHaveLength(0);
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
