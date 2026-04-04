import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  encodeMediaForProvider,
  turnPartsToText,
  turnPartsToOpenAIContent,
} from '../../../../src/runtimes/agent/providers/media-bridge.ts';
import {
  generateMcpConfigFile,
  convertMcpToolsToOpenAI,
  convertMcpToolsToAnthropic,
  getMcpStrategy,
} from '../../../../src/runtimes/agent/providers/mcp-bridge.ts';
import { ClaudeProvider } from '../../../../src/runtimes/agent/providers/claude.ts';

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
});

// ---------------------------------------------------------------------------
// MCP Bridge
// ---------------------------------------------------------------------------

describe('generateMcpConfigFile', () => {
  it('claude-cli → returns object with mcpServers.whatsoup', () => {
    const result = generateMcpConfigFile('claude-cli', '/tmp/whatsoup.sock', '/tmp/proxy.ts');
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).mcpServers).toBeDefined();
    const servers = (result as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(servers.whatsoup).toBeDefined();
  });

  it('codex-cli → returns same format with mcpServers.whatsoup', () => {
    const result = generateMcpConfigFile('codex-cli', '/tmp/whatsoup.sock', '/tmp/proxy.ts');
    expect(result).not.toBeNull();
    const servers = (result as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(servers.whatsoup).toBeDefined();
  });

  it('openai-api → returns null', () => {
    const result = generateMcpConfigFile('openai-api', '/tmp/whatsoup.sock', '/tmp/proxy.ts');
    expect(result).toBeNull();
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

describe('getMcpStrategy', () => {
  it('claude-cli → config_file', () => {
    expect(getMcpStrategy('claude-cli')).toBe('config_file');
  });

  it('openai-api → native_bridge', () => {
    expect(getMcpStrategy('openai-api')).toBe('native_bridge');
  });

  it('unknown → none', () => {
    expect(getMcpStrategy('unknown-provider')).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Env allowlist — tested via ClaudeProvider.buildEnv()
// ---------------------------------------------------------------------------

describe('buildEnv (via ClaudeProvider.buildEnv)', () => {
  const provider = new ClaudeProvider();

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and set up a known process.env state
    const keys = [
      'PATH', 'HOME', 'USER',
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
      'PINECONE_API_KEY', 'WHATSOUP_HEALTH_TOKEN',
    ];
    for (const key of keys) {
      savedEnv[key] = process.env[key];
    }
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = '/home/testuser';
    process.env.USER = 'testuser';
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    process.env.PINECONE_API_KEY = 'pinecone-secret';
    process.env.WHATSOUP_HEALTH_TOKEN = 'health-secret';
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it('PATH is present', () => {
    const env = provider.buildEnv();
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('HOME is present', () => {
    const env = provider.buildEnv();
    expect(env.HOME).toBe('/home/testuser');
  });

  it('USER is present', () => {
    const env = provider.buildEnv();
    expect(env.USER).toBe('testuser');
  });

  it('OPENAI_API_KEY is included when set', () => {
    const env = provider.buildEnv();
    expect(env.OPENAI_API_KEY).toBe('sk-openai-test');
  });

  it('PINECONE_API_KEY is excluded', () => {
    const env = provider.buildEnv();
    expect(env.PINECONE_API_KEY).toBeUndefined();
  });

  it('WHATSOUP_HEALTH_TOKEN is excluded', () => {
    const env = provider.buildEnv();
    expect(env.WHATSOUP_HEALTH_TOKEN).toBeUndefined();
  });

  it('ANTHROPIC_API_KEY is excluded', () => {
    const env = provider.buildEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('undefined values are stripped from the result', () => {
    // Remove PATH so it's undefined in process.env, then check it's absent
    delete process.env.PATH;
    const env = provider.buildEnv();
    // The result should not have PATH as a key with value undefined
    const hasUndefinedValues = Object.values(env).some(v => v === undefined);
    expect(hasUndefinedValues).toBe(false);
    // PATH should not appear as a key since it's undefined
    expect('PATH' in env).toBe(false);
  });
});
