// deploy/mcp/send-media-server.ts
// Stdio MCP server for the send_media tool.
// Claude Code launches this as a subprocess via .mcp.json.
// It validates file paths against the sandbox boundary, connects to the
// media bridge Unix socket, and sends the file as a WhatsApp media message.

import { createConnection } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: unknown;
  method?: string;
  params?: unknown;
}

interface SandboxPolicy {
  allowedPaths?: string[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

const SOCKET_PATH = process.env['MEDIA_BRIDGE_SOCKET'];
if (!SOCKET_PATH) {
  process.stderr.write('MEDIA_BRIDGE_SOCKET environment variable is required\n');
  process.exit(1);
}

// Determine the allowed root from sandbox-policy.json or cwd
function resolveAllowedRoot(socketPath: string): string {
  const socketDir = dirname(socketPath);
  const policyPath = resolve(socketDir, 'sandbox-policy.json');
  if (existsSync(policyPath)) {
    try {
      const raw = readFileSync(policyPath, 'utf8');
      const policy = JSON.parse(raw) as SandboxPolicy;
      const first = policy.allowedPaths?.[0];
      if (first) {
        // Expand ~
        const expanded = first.startsWith('~/')
          ? resolve(process.env['HOME'] ?? '/', first.slice(2))
          : first;
        return resolve(expanded);
      }
    } catch {
      // Malformed policy — fall through to cwd
    }
  }
  return process.cwd();
}

const ALLOWED_ROOT = resolveAllowedRoot(SOCKET_PATH);

// ─── MCP response helpers ─────────────────────────────────────────────────────

function respond(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id: unknown, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const SEND_MEDIA_TOOL = {
  name: 'send_media',
  description:
    'Send a file as a WhatsApp media message (image, document, audio, video). The file must be within the allowed working directory.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file to send',
      },
      caption: {
        type: 'string',
        description: 'Optional caption for images, documents, and videos',
      },
      filename: {
        type: 'string',
        description: 'Optional display filename (defaults to the file basename)',
      },
    },
    required: ['path'],
  },
};

// ─── Path validation ──────────────────────────────────────────────────────────

function validatePath(filePath: string): { ok: true; resolved: string } | { ok: false; error: string } {
  const resolved = resolve(filePath);
  if (!resolved.startsWith(ALLOWED_ROOT + '/') && resolved !== ALLOWED_ROOT) {
    return { ok: false, error: `path outside allowed directory: ${resolved} (allowed: ${ALLOWED_ROOT})` };
  }
  return { ok: true, resolved };
}

// ─── Bridge socket request ────────────────────────────────────────────────────

interface BridgeRequest {
  path: string;
  caption?: string;
  filename?: string;
}

interface BridgeResponse {
  ok: boolean;
  error?: string;
}

function sendToBridge(
  socketPath: string,
  request: BridgeRequest,
): Promise<BridgeResponse> {
  return new Promise((resolvePromise) => {
    if (!existsSync(socketPath)) {
      resolvePromise({ ok: false, error: `media bridge socket not found: ${socketPath}` });
      return;
    }

    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(request) + '\n');
    });

    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString();
      const newline = buf.indexOf('\n');
      if (newline !== -1) {
        const line = buf.slice(0, newline).trim();
        client.destroy();
        try {
          resolvePromise(JSON.parse(line) as BridgeResponse);
        } catch {
          resolvePromise({ ok: false, error: 'invalid JSON from bridge' });
        }
      }
    });

    client.on('error', (err) => {
      resolvePromise({ ok: false, error: `socket error: ${(err as Error).message}` });
    });

    // Handle bridge shutdown mid-request (server.close() or crash) — without this,
    // the promise hangs for the full 10s timeout.
    client.on('close', () => {
      resolvePromise({ ok: false, error: 'bridge closed connection before responding' });
    });

    client.setTimeout(10_000, () => {
      client.destroy();
      resolvePromise({ ok: false, error: 'bridge request timed out' });
    });
  });
}

// ─── Tool call handler ────────────────────────────────────────────────────────

async function handleSendMedia(
  id: unknown,
  params: unknown,
): Promise<void> {
  const args = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};
  const filePath = typeof args['path'] === 'string' ? args['path'] : null;

  if (!filePath) {
    respond(id, {
      content: [{ type: 'text', text: 'Error: path argument is required' }],
      isError: true,
    });
    return;
  }

  const validation = validatePath(filePath);
  if (!validation.ok) {
    respond(id, {
      content: [{ type: 'text', text: `Error: ${validation.error}` }],
      isError: true,
    });
    return;
  }

  const caption = typeof args['caption'] === 'string' ? args['caption'] : undefined;
  const filename =
    typeof args['filename'] === 'string'
      ? args['filename']
      : basename(validation.resolved);

  const request: BridgeRequest = {
    path: validation.resolved,
    ...(caption !== undefined && { caption }),
    filename,
  };

  const result = await sendToBridge(SOCKET_PATH as string, request);

  if (result.ok) {
    respond(id, {
      content: [{ type: 'text', text: `Sent ${basename(validation.resolved)} to chat` }],
    });
  } else {
    respond(id, {
      content: [{ type: 'text', text: `Error: ${result.error ?? 'unknown error'}` }],
      isError: true,
    });
  }
}

// ─── Message dispatcher ───────────────────────────────────────────────────────

async function handleMessage(msg: JsonRpcMessage): Promise<void> {
  const { id, method } = msg;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'send-media', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      // No response required for notifications
      break;

    case 'tools/list':
      respond(id, { tools: [SEND_MEDIA_TOOL] });
      break;

    case 'tools/call': {
      const params = msg.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      if (params?.name === 'send_media') {
        await handleSendMedia(id, params);
      } else {
        respondError(id, -32601, `Unknown tool: ${params?.name ?? '(none)'}`);
      }
      break;
    }

    default:
      if (id !== undefined && id !== null) {
        respondError(id, -32601, `Method not found: ${method ?? '(none)'}`);
      }
      break;
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(trimmed) as JsonRpcMessage;
  } catch {
    respondError(null, -32700, 'Parse error: invalid JSON');
    return;
  }

  handleMessage(msg).catch((err) => {
    process.stderr.write(`Unhandled error: ${(err as Error).message}\n`);
    if (msg.id !== undefined && msg.id !== null) {
      respondError(msg.id, -32603, 'Internal error');
    }
  });
});

rl.on('close', () => {
  process.exit(0);
});
