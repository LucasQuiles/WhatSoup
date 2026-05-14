import { readFileSync } from 'node:fs';

export const MIN_ASSISTANT_TEXT_CHARS = 4;

export const WHATSAPP_SEND_TOOLS = new Set([
  'mcp__whatsoup__send_message',
  'mcp__whatsoup__send_media',
  'mcp__whatsoup__reply_message',
  'mcp__whatsoup__react_message',
  'mcp__whatsoup__send_voice_reply',
  'mcp__whatsoup__send_location',
  'mcp__whatsoup__send_contact',
  'mcp__whatsoup__send_button_reply',
  'mcp__whatsoup__send_list_reply',
  'mcp__whatsoup__forward_message',
  'mcp__whatsoup__edit_message',
]);

function parseTranscript(raw) {
  const records = [];
  let malformedLines = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformedLines += 1;
    }
  }

  return { records, malformedLines };
}

function contentBlocks(record) {
  const content = record?.message?.content;
  return Array.isArray(content) ? content : [];
}

function isHumanUserRecord(record) {
  if (record?.type !== 'user' || record.isMeta) return false;

  const message = record.message;
  if (typeof message === 'string') return message.trim().length > 0;

  const blocks = contentBlocks(record);
  if (blocks.length === 0) return false;

  const hasUserText = blocks.some(
    (block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0,
  );
  const allToolResults = blocks.every((block) => block?.type === 'tool_result');

  return hasUserText && !allToolResults;
}

function isSuccessfulToolResult(block) {
  return block?.type === 'tool_result'
    && block.is_error !== true
    && block.isError !== true
    && block.error == null;
}

function assistantTextBlocks(record) {
  const blocks = contentBlocks(record);
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
}

export function inspectTranscript(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `transcript read failed: ${message}` };
  }

  const { records, malformedLines } = parseTranscript(raw);

  let lastUserIdx = -1;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (isHumanUserRecord(records[i])) {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx < 0) {
    return {
      lastUserIdx,
      assistantTextChars: 0,
      sendsAfter: 0,
      lastAssistantText: '',
      malformedLines,
    };
  }

  let assistantTextChars = 0;
  const whatsappToolUseIds = [];

  for (let i = lastUserIdx + 1; i < records.length; i += 1) {
    const record = records[i];
    if (record?.type !== 'assistant') continue;

    for (const text of assistantTextBlocks(record)) {
      const trimmed = text.trim();
      if (trimmed.length > 0) assistantTextChars += trimmed.length;
    }

    for (const block of contentBlocks(record)) {
      if (block?.type === 'tool_use' && WHATSAPP_SEND_TOOLS.has(block.name) && typeof block.id === 'string') {
        whatsappToolUseIds.push(block.id);
      }
    }
  }

  const successfulResults = new Set();
  for (let i = lastUserIdx + 1; i < records.length; i += 1) {
    const record = records[i];
    if (record?.type !== 'user') continue;
    for (const block of contentBlocks(record)) {
      if (typeof block?.tool_use_id === 'string' && isSuccessfulToolResult(block)) {
        successfulResults.add(block.tool_use_id);
      }
    }
  }

  const sendsAfter = whatsappToolUseIds.filter((id) => successfulResults.has(id)).length;

  let lastAssistantText = '';
  for (let i = records.length - 1; i > lastUserIdx; i -= 1) {
    const texts = assistantTextBlocks(records[i]);
    if (texts.length === 0) continue;
    lastAssistantText = texts[texts.length - 1].slice(0, 500);
    break;
  }

  return {
    lastUserIdx,
    assistantTextChars,
    sendsAfter,
    lastAssistantText,
    malformedLines,
  };
}

export function hasVisibleReply(inspection) {
  if (!inspection || inspection.error || inspection.lastUserIdx < 0) return false;
  return (inspection.sendsAfter || 0) > 0
    || (inspection.assistantTextChars || 0) >= MIN_ASSISTANT_TEXT_CHARS;
}
