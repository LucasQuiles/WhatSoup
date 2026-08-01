import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// @ts-expect-error -- hook libraries are JavaScript modules imported by Node hooks; expires 2026-08-14
import { hasVisibleReply, inspectTranscript, MIN_ASSISTANT_TEXT_CHARS, WHATSAPP_SEND_TOOLS } from '../../deploy/hooks/lib/transcript-walk.mjs';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('whatsoup-');

function writeTranscript(records: unknown[]): string {
  const path = join(tmp.make('transcript'), 'transcript.jsonl');
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return path;
}

describe('transcript-walk', () => {
  it('counts assistant text after the last human user message as a visible reply', () => {
    const reply = 'I found the answer.';
    const path = writeTranscript([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Can you check this?' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } },
    ]);

    const inspection = inspectTranscript(path);

    expect(inspection.lastUserIdx).toBe(0);
    expect(inspection.assistantTextChars).toBe(reply.length);
    expect(inspection.sendsAfter).toBe(0);
    expect(hasVisibleReply(inspection)).toBe(true);
  });

  it('counts a successful WhatsApp send tool result as a visible reply', () => {
    const path = writeTranscript([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Send the photo.' }] } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'send-1', name: 'mcp__whatsoup__send_media', input: {} }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'send-1', content: 'sent', is_error: false }],
        },
      },
    ]);

    const inspection = inspectTranscript(path);

    expect(inspection.sendsAfter).toBe(1);
    expect(hasVisibleReply(inspection)).toBe(true);
  });

  it('does not count a failed WhatsApp send tool result as a visible reply', () => {
    const path = writeTranscript([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Reply now.' }] } },
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
          content: [{ type: 'tool_result', tool_use_id: 'send-1', content: 'failed', is_error: true }],
        },
      },
    ]);

    const inspection = inspectTranscript(path);

    expect(inspection.sendsAfter).toBe(0);
    expect(hasVisibleReply(inspection)).toBe(false);
  });

  it('ignores tool_result-only user messages when finding the last human message', () => {
    const path = writeTranscript([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Please research this.' }] } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }],
        },
      },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The result is ready.' }] } },
    ]);

    const inspection = inspectTranscript(path);

    expect(inspection.lastUserIdx).toBe(0);
    expect(hasVisibleReply(inspection)).toBe(true);
  });

  it('tolerates malformed transcript lines', () => {
    const path = join(tmp.make('transcript'), 'transcript.jsonl');
    writeFileSync(path, [
      'not json',
      JSON.stringify({ type: 'user', message: 'hello' }),
      '{broken',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'response' }] } }),
    ].join('\n'));

    const inspection = inspectTranscript(path);

    expect(inspection.error).toBeUndefined();
    expect(inspection.malformedLines).toBe(2);
    expect(inspection.lastUserIdx).toBe(0);
    expect(hasVisibleReply(inspection)).toBe(true);
  });

  it('applies the minimum assistant text threshold', () => {
    expect(hasVisibleReply({
      lastUserIdx: 0,
      assistantTextChars: MIN_ASSISTANT_TEXT_CHARS - 1,
      sendsAfter: 0,
    })).toBe(false);
    expect(hasVisibleReply({
      lastUserIdx: 0,
      assistantTextChars: MIN_ASSISTANT_TEXT_CHARS,
      sendsAfter: 0,
    })).toBe(true);
  });

  it('pins the WhatsApp send tool allowlist deliberately', () => {
    expect([...WHATSAPP_SEND_TOOLS].sort()).toEqual([
      'mcp__whatsoup__edit_message',
      'mcp__whatsoup__forward_message',
      'mcp__whatsoup__react_message',
      'mcp__whatsoup__reply_message',
      'mcp__whatsoup__send_button_reply',
      'mcp__whatsoup__send_contact',
      'mcp__whatsoup__send_list_reply',
      'mcp__whatsoup__send_location',
      'mcp__whatsoup__send_media',
      'mcp__whatsoup__send_message',
      'mcp__whatsoup__send_voice_reply',
    ]);
  });
});
