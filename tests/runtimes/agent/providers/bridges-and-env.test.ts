import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  encodeMediaForProvider,
  turnPartsToText,
  turnPartsToOpenAIContent,
  turnPartsToAnthropicContent,
} from '../../../../src/runtimes/agent/providers/media-bridge.ts';
import {
  generateMcpConfigFile,
  convertMcpToolsToOpenAI,
  convertMcpToolsToAnthropic,
} from '../../../../src/runtimes/agent/providers/mcp-bridge.ts';
import { buildMcpLaunchCommand } from '../../../../src/core/mcp-launcher.ts';

// ---------------------------------------------------------------------------
// Media Bridge
// ---------------------------------------------------------------------------

describe('encodeMediaForProvider', () => {
  it('text parts pass through for file_path mode', () => {
    const { textParts } = encodeMediaForProvider(
      [{ kind: 'text', text: 'hello' }],
      'file_path',
    );
    expect(textParts).toEqual(['hello']);
  });

  it('text parts pass through for startup_only mode', () => {
    const { textParts } = encodeMediaForProvider(
      [{ kind: 'text', text: 'world' }],
      'startup_only',
    );
    expect(textParts).toEqual(['world']);
  });

  it('text parts pass through for base64 mode', () => {
    const { textParts } = encodeMediaForProvider(
      [{ kind: 'text', text: 'test' }],
      'base64',
    );
    expect(textParts).toEqual(['test']);
  });

  it('text parts pass through for native mode', () => {
    const { textParts } = encodeMediaForProvider(
      [{ kind: 'text', text: 'gemini' }],
      'native',
    );
    expect(textParts).toEqual(['gemini']);
  });

  it('text parts pass through for none mode', () => {
    const { textParts } = encodeMediaForProvider(
      [{ kind: 'text', text: 'none test' }],
      'none',
    );
    expect(textParts).toEqual(['none test']);
  });

  it('file_path mode: image with filePath → textParts contains [Image: /path]', () => {
    const { textParts, mediaFlags, base64Parts, pendingFiles } = encodeMediaForProvider(
      [{ kind: 'image', mimeType: 'image/jpeg', filePath: '/tmp/photo.jpg' }],
      'file_path',
    );
    expect(textParts).toHaveLength(1);
    expect(textParts[0]).toContain('[Image: /tmp/photo.jpg]');
    expect(mediaFlags).toHaveLength(0);
    expect(base64Parts).toHaveLength(0);
    expect(pendingFiles).toHaveLength(0);
  });

  it('file_path mode: image with caption keeps the file reference and caption together', () => {
    const { textParts } = encodeMediaForProvider(
      [{ kind: 'image', mimeType: 'image/jpeg', filePath: '/tmp/photo.jpg', caption: 'front panel' }],
      'file_path',
    );

    expect(textParts).toEqual(['[Image: /tmp/photo.jpg] front panel']);
  });

  it('startup_only mode: image with filePath → mediaFlags contains --image /path', () => {
    const { textParts, mediaFlags } = encodeMediaForProvider(
      [{ kind: 'image', mimeType: 'image/png', filePath: '/tmp/img.png' }],
      'startup_only',
    );
    expect(mediaFlags).toContain('--image');
    expect(mediaFlags).toContain('/tmp/img.png');
    expect(textParts).toHaveLength(0);
  });

  it('startup_only mode: image without filePath mid-conversation → textParts contains "cannot be displayed"', () => {
    const { textParts, mediaFlags } = encodeMediaForProvider(
      [{ kind: 'image', mimeType: 'image/png' }],
      'startup_only',
    );
    expect(textParts.join(' ')).toContain('cannot be displayed');
    expect(mediaFlags).toHaveLength(0);
  });

  it('base64 mode: image with base64 data → base64Parts populated', () => {
    const { base64Parts, pendingFiles } = encodeMediaForProvider(
      [{ kind: 'image', mimeType: 'image/jpeg', base64: 'abc123' }],
      'base64',
    );
    expect(base64Parts).toHaveLength(1);
    expect(base64Parts[0]).toEqual({ mimeType: 'image/jpeg', data: 'abc123' });
    expect(pendingFiles).toHaveLength(0);
  });

  it('base64 mode: image with filePath but no base64 → pendingFiles populated (not silently dropped)', () => {
    const { base64Parts, pendingFiles } = encodeMediaForProvider(
      [{ kind: 'image', mimeType: 'image/png', filePath: '/tmp/needs-encoding.png' }],
      'base64',
    );
    expect(pendingFiles).toHaveLength(1);
    expect(pendingFiles[0]).toEqual({ mimeType: 'image/png', filePath: '/tmp/needs-encoding.png' });
    expect(base64Parts).toHaveLength(0);
  });

  it('base64 mode: image without data or file path still preserves caption text', () => {
    const { textParts, base64Parts, pendingFiles } = encodeMediaForProvider(
      [{ kind: 'image', mimeType: 'image/png', caption: 'missing upload payload' }],
      'base64',
    );

    expect(textParts).toEqual(['missing upload payload']);
    expect(base64Parts).toEqual([]);
    expect(pendingFiles).toEqual([]);
  });

  it('native mode (Gemini): image with filePath → textParts contains @/path', () => {
    const { textParts, mediaFlags, base64Parts } = encodeMediaForProvider(
      [{ kind: 'image', mimeType: 'image/jpeg', filePath: '/tmp/native.jpg' }],
      'native',
    );
    expect(textParts).toHaveLength(1);
    expect(textParts[0]).toBe('@/tmp/native.jpg');
    expect(mediaFlags).toHaveLength(0);
    expect(base64Parts).toHaveLength(0);
  });

  it('native mode: image without a file path is omitted', () => {
    const { textParts } = encodeMediaForProvider(
      [{ kind: 'image', mimeType: 'image/jpeg' }],
      'native',
    );

    expect(textParts).toEqual([]);
  });

  it('none mode: image → textParts contains "does not support images"', () => {
    const { textParts } = encodeMediaForProvider(
      [{ kind: 'image', mimeType: 'image/png', filePath: '/tmp/img.png' }],
      'none',
    );
    expect(textParts.join(' ')).toContain('does not support images');
  });

  it('audio with transcript → textParts contains transcript text', () => {
    const { textParts } = encodeMediaForProvider(
      [{ kind: 'audio', mimeType: 'audio/ogg', transcript: 'Hello there' }],
      'file_path',
    );
    expect(textParts.join(' ')).toContain('Hello there');
  });

  it('audio without transcript falls back to file path and omits empty audio parts', () => {
    const { textParts } = encodeMediaForProvider(
      [
        { kind: 'audio', mimeType: 'audio/ogg', filePath: '/tmp/voice.ogg' },
        { kind: 'audio', mimeType: 'audio/ogg' },
      ],
      'file_path',
    );

    expect(textParts).toEqual(['[Audio file: /tmp/voice.ogg]']);
  });

  it('document with extractedText → textParts contains extracted content', () => {
    const { textParts } = encodeMediaForProvider(
      [{
        kind: 'document',
        mimeType: 'application/pdf',
        filePath: '/tmp/doc.pdf',
        extractedText: 'This is the document body',
        filename: 'doc.pdf',
      }],
      'file_path',
    );
    expect(textParts.join('\n')).toContain('This is the document body');
  });

  it('document formatting falls back to default filename and raw file path evidence', () => {
    const { textParts } = encodeMediaForProvider(
      [
        {
          kind: 'document',
          mimeType: 'application/pdf',
          filePath: '/tmp/unnamed.pdf',
          extractedText: 'Unnamed body',
        },
        {
          kind: 'document',
          mimeType: 'application/pdf',
          filePath: '/tmp/raw.pdf',
        },
      ],
      'file_path',
    );

    expect(textParts).toEqual([
      '[Document: file]\nUnnamed body',
      '[Document: /tmp/raw.pdf]',
    ]);
  });
});

describe('turnPartsToText', () => {
  it('joins text parts with newlines', () => {
    const result = turnPartsToText(
      [
        { kind: 'text', text: 'line one' },
        { kind: 'text', text: 'line two' },
        { kind: 'text', text: 'line three' },
      ],
      'file_path',
    );
    expect(result).toBe('line one\nline two\nline three');
  });
});

describe('turnPartsToOpenAIContent', () => {
  it('text part → {type: text, text}', () => {
    const result = turnPartsToOpenAIContent([{ kind: 'text', text: 'hello' }]);
    expect(result).toContainEqual({ type: 'text', text: 'hello' });
  });

  it('image with base64 → {type: image_url, image_url: {url: data:mime;base64,...}}', () => {
    const result = turnPartsToOpenAIContent([
      { kind: 'image', mimeType: 'image/jpeg', base64: 'abc123' },
    ]);
    expect(result).toContainEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,abc123' },
    });
  });

  it('preserves image captions, audio transcripts, and extracted documents', () => {
    const result = turnPartsToOpenAIContent([
      { kind: 'image', mimeType: 'image/png', base64: 'imgdata', caption: 'panel detail' },
      { kind: 'audio', mimeType: 'audio/ogg', transcript: 'spoken words' },
      {
        kind: 'document',
        mimeType: 'text/plain',
        filePath: '/tmp/brief.txt',
        filename: 'brief.txt',
        extractedText: 'brief body',
      },
      {
        kind: 'document',
        mimeType: 'text/plain',
        filePath: '/tmp/unnamed.txt',
        extractedText: 'unnamed body',
      },
    ]);

    expect(result).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,imgdata' } },
      { type: 'text', text: 'panel detail' },
      { type: 'text', text: '[Audio]: spoken words' },
      { type: 'text', text: '[brief.txt]:\nbrief body' },
      { type: 'text', text: '[Document]:\nunnamed body' },
    ]);
  });

  it('returns an empty text block when no provider content can be encoded', () => {
    const result = turnPartsToOpenAIContent([
      { kind: 'image', mimeType: 'image/png' },
      { kind: 'audio', mimeType: 'audio/ogg' },
      { kind: 'document', mimeType: 'application/pdf', filePath: '/tmp/raw.pdf' },
    ]);

    expect(result).toEqual([{ type: 'text', text: '' }]);
  });
});

describe('turnPartsToAnthropicContent', () => {
  it('encodes text, images, captions, audio transcripts, and extracted documents', () => {
    const result = turnPartsToAnthropicContent([
      { kind: 'text', text: 'hello' },
      { kind: 'image', mimeType: 'image/jpeg', base64: 'abc123', caption: 'close up' },
      { kind: 'audio', mimeType: 'audio/ogg', transcript: 'audio words' },
      {
        kind: 'document',
        mimeType: 'text/plain',
        filePath: '/tmp/notes.txt',
        filename: 'notes.txt',
        extractedText: 'notes body',
      },
      {
        kind: 'document',
        mimeType: 'text/plain',
        filePath: '/tmp/unnamed.txt',
        extractedText: 'unnamed body',
      },
    ]);

    expect(result).toEqual([
      { type: 'text', text: 'hello' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
      },
      { type: 'text', text: 'close up' },
      { type: 'text', text: '[Audio]: audio words' },
      { type: 'text', text: '[notes.txt]:\nnotes body' },
      { type: 'text', text: '[Document]:\nunnamed body' },
    ]);
  });

  it('returns an empty text block when no Anthropic content can be encoded', () => {
    const result = turnPartsToAnthropicContent([
      { kind: 'image', mimeType: 'image/png' },
      { kind: 'audio', mimeType: 'audio/ogg' },
      { kind: 'document', mimeType: 'application/pdf', filePath: '/tmp/raw.pdf' },
    ]);

    expect(result).toEqual([{ type: 'text', text: '' }]);
  });
});

// ---------------------------------------------------------------------------
// MCP Bridge
// ---------------------------------------------------------------------------

describe('generateMcpConfigFile', () => {
  it('claude-cli → returns object with mcpServers.whatsoup', () => {
    const result = generateMcpConfigFile('claude-cli', '/tmp/whatsoup.sock', '/tmp/proxy.ts');
    expect(result).toEqual({
      mcpServers: {
        whatsoup: {
          ...buildMcpLaunchCommand('/tmp/proxy.ts'),
          env: { WHATSOUP_SOCKET: '/tmp/whatsoup.sock' },
        },
      },
    });
  });

  it('codex-cli → returns same format with mcpServers.whatsoup', () => {
    const result = generateMcpConfigFile('codex-cli', '/tmp/whatsoup.sock', '/tmp/proxy.ts');
    expect(result).toEqual({
      mcpServers: {
        whatsoup: {
          ...buildMcpLaunchCommand('/tmp/proxy.ts'),
          env: { WHATSOUP_SOCKET: '/tmp/whatsoup.sock' },
        },
      },
    });
  });

  it('openai-api → returns null', () => {
    const result = generateMcpConfigFile('openai-api', '/tmp/whatsoup.sock', '/tmp/proxy.ts');
    expect(result).toStrictEqual(null);
  });
});

describe('convertMcpToolsToOpenAI', () => {
  it('maps name/description/inputSchema to function format', () => {
    const tools = [
      {
        name: 'send_message',
        description: 'Send a WhatsApp message',
        inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
      },
    ];
    const result = convertMcpToolsToOpenAI(tools);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'function',
      function: {
        name: 'send_message',
        description: 'Send a WhatsApp message',
        parameters: { type: 'object', properties: { to: { type: 'string' } } },
      },
    });
  });
});

describe('convertMcpToolsToAnthropic', () => {
  it('maps to name/description/input_schema format', () => {
    const tools = [
      {
        name: 'list_chats',
        description: 'List all chats',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const result = convertMcpToolsToAnthropic(tools);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'list_chats',
      description: 'List all chats',
      input_schema: { type: 'object', properties: {} },
    });
  });
});
