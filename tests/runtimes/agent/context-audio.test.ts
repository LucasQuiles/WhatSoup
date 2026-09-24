import { describe, it, expect } from 'vitest';
import { renderVoiceNotes } from '../../../src/runtimes/agent/context-audio.ts';
import { formatContextLines, CONTEXT_LINE_MAX_CHARS_PER_MESSAGE } from '../../../src/runtimes/agent/context-lines.ts';

const AUDIO_JSON = JSON.stringify({ type: 'audio', duration: 12, ptt: true, transcription: null });

function audio(messageId: string, content: string, contentText: string | null) {
  return { messageId, contentType: 'audio' as const, content, contentText, timestamp: 1_790_000_000, senderName: 'Sender', senderJid: '15550003333@s.whatsapp.net' };
}

describe('renderVoiceNotes', () => {
  it('renders an untranscribed voice note as an explicit marker, never its JSON', () => {
    // StoredMessage falls back contentText to content when content_text is NULL.
    const [rendered] = renderVoiceNotes([audio('VOICE0001', AUDIO_JSON, AUDIO_JSON)]);
    expect(rendered!.content).toBe('[Voice note — not transcribed (message VOICE0001)]');
    expect(formatContextLines([rendered!], false)).not.toContain('"transcription"');
  });

  it('renders a stored transcript from content_text', () => {
    const merged = JSON.stringify({ type: 'audio', duration: 12, ptt: true, transcription: 'call me back' });
    const [rendered] = renderVoiceNotes([audio('VOICE0002', merged, 'call me back')]);
    expect(rendered!.content).toBe('[Voice note transcription]: call me back');
  });

  it('reads a transcript stored only inside the content JSON', () => {
    const merged = JSON.stringify({ type: 'audio', transcription: 'only in json' });
    const [rendered] = renderVoiceNotes([audio('VOICE0003', merged, merged)]);
    expect(rendered!.content).toBe('[Voice note transcription]: only in json');
  });

  it('never treats the transcription fallback text as a transcript', () => {
    const fallback = '[🎤 Voice note received — transcription unavailable]';
    const [rendered] = renderVoiceNotes([audio('VOICE0004', AUDIO_JSON, fallback)]);
    expect(rendered!.content).toBe('[Voice note — not transcribed (message VOICE0004)]');
  });

  it('truncates a long transcript within the per-message cap and points at the stored text', () => {
    const long = 'word '.repeat(1_000);
    const [rendered] = renderVoiceNotes([audio('VOICE0005', AUDIO_JSON, long)]);
    expect(rendered!.content!.length).toBeLessThanOrEqual(CONTEXT_LINE_MAX_CHARS_PER_MESSAGE);
    expect(rendered!.content).toMatch(/transcript truncated; full text stored with message VOICE0005]$/);
    expect(formatContextLines([rendered!], false)).not.toContain('[truncated');
  });

  it('leaves non-audio messages untouched and keeps order', () => {
    const text = { messageId: 'TEXT0001', contentType: 'text' as const, content: 'hello', contentText: 'hello' };
    const input = [text, audio('VOICE0006', AUDIO_JSON, null)];
    const rendered = renderVoiceNotes(input);
    expect(rendered[0]).toBe(text);
    expect(rendered.map((m) => m.messageId)).toEqual(['TEXT0001', 'VOICE0006']);
  });
});
