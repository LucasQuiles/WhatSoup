import net from 'node:net';
import { isAbsolute } from 'node:path';
import { isSignalTcpHost } from '../../lib/signal-endpoint.ts';
import type { SignalConfig } from './types.ts';
import type {
  InboundSignal,
  ReactSignalArgs,
  RemoteDeleteSignalArgs,
  SendReadReceiptArgs,
  SendSignalArgs,
  SendTypingArgs,
  SignalPort,
  SignalPortError,
} from './port.ts';

export interface SignalRpcConnection {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export type SignalRpcConnectionFactory = (
  config: SignalConfig,
  onTerminal?: () => void,
) => SignalRpcConnection;

const RPC_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RECEIVE_PAGE_SIZE = 500;

function assertEndpoint(config: SignalConfig): void {
  const hasSocket = typeof config.socketPath === 'string' && config.socketPath.length > 0;
  const hasTcp = Number.isInteger(config.tcpPort)
    && (config.tcpPort ?? 0) >= 1
    && (config.tcpPort ?? 0) <= 65_535;
  if (hasSocket === hasTcp) {
    throw new Error('SignalCliPort requires exactly one valid socketPath or tcpPort endpoint');
  }
  if (hasSocket && !isAbsolute(config.socketPath!)) {
    throw new Error('SignalCliPort socketPath must be absolute');
  }
  if (hasTcp && config.tcpHost !== undefined && !isSignalTcpHost(config.tcpHost)) {
    throw new Error('SignalCliPort plaintext TCP requires a loopback host');
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: SignalPortError) => void;
  timer: NodeJS.Timeout;
}

export function createSocketConnection(
  config: SignalConfig,
  onTerminal?: () => void,
): SignalRpcConnection {
  assertEndpoint(config);
  const socket = config.socketPath !== undefined
    ? net.createConnection(config.socketPath)
    : net.createConnection({
        host: config.tcpHost ?? '127.0.0.1',
        port: config.tcpPort!,
      });
  const pending = new Map<number, PendingRequest>();
  let buffer = '';
  let nextId = 1;
  let terminalError: SignalPortError | null = null;

  const terminate = (error: SignalPortError): void => {
    if (terminalError !== null) return;
    terminalError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    onTerminal?.();
  };

  socket.on('error', (error) => {
    terminate({
      message: `signal-cli socket error: ${error.message}`,
      code: 'SocketError',
      status: 503,
    });
  });
  socket.on('end', () => {
    terminate({
      message: 'signal-cli connection ended by peer',
      code: 'Closed',
      status: 503,
    });
  });
  socket.on('close', () => {
    terminate({
      message: 'signal-cli connection closed',
      code: 'Closed',
      status: 503,
    });
  });

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line === '') continue;

      let frame: {
        id?: number;
        result?: unknown;
        error?: { code?: unknown; message?: unknown };
      };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        continue;
      }
      if (frame.id === undefined) continue;
      const request = pending.get(frame.id);
      if (request === undefined) continue;
      pending.delete(frame.id);
      clearTimeout(request.timer);
      if (frame.error !== undefined) {
        request.reject({
          message: typeof frame.error.message === 'string'
            ? frame.error.message
            : 'signal-cli RPC error',
          code: frame.error.code === undefined ? undefined : String(frame.error.code),
        });
      } else {
        request.resolve(frame.result);
      }
    }
  });

  return {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      if (terminalError !== null) return Promise.reject(terminalError);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          const error = {
            message: `signal-cli RPC ${method} timed out after ${RPC_REQUEST_TIMEOUT_MS}ms`,
            code: 'Timeout',
            status: 504,
          } satisfies SignalPortError;
          reject(error);
          terminate(error);
          socket.destroy();
        }, RPC_REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        socket.write(
          `${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {}, id })}\n`,
          (error) => {
            if (error === null || error === undefined) return;
            const rpcError = {
              message: `signal-cli socket write failed: ${error.message}`,
              code: 'SocketError',
              status: 503,
            } satisfies SignalPortError;
            terminate(rpcError);
            socket.destroy();
          },
        );
      });
    },
    close(): void {
      terminate({
        message: 'signal-cli connection closed',
        code: 'Closed',
        status: 503,
      });
      socket.destroy();
    },
  };
}

interface RpcEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  timestamp?: number;
  dataMessage?: {
    message?: string | null;
    groupInfo?: { groupId?: string };
  };
  syncMessage?: {
    sentMessage?: {
      message?: string | null;
      destination?: string;
      destinationNumber?: string;
      destinationUuid?: string;
      groupInfo?: { groupId?: string };
      timestamp?: number;
    };
  };
}

function normalizeEnvelope(envelope: RpcEnvelope, ownNumber: string): InboundSignal | null {
  const sent = envelope.syncMessage?.sentMessage;
  if (sent !== undefined) {
    const timestamp = sent.timestamp ?? envelope.timestamp;
    const destination = sent.groupInfo?.groupId
      ?? sent.destinationNumber
      ?? sent.destinationUuid
      ?? sent.destination;
    if (!Number.isSafeInteger(timestamp) || (timestamp ?? 0) <= 0) return null;
    if (typeof destination !== 'string' || destination.length === 0) return null;
    return {
      timestamp: timestamp!,
      source: ownNumber,
      destination,
      groupId: sent.groupInfo?.groupId,
      body: sent.message ?? null,
      fromMe: true,
      type: 'sync',
    };
  }
  if (envelope.dataMessage !== undefined) {
    const timestamp = envelope.timestamp;
    const source = envelope.sourceNumber ?? envelope.sourceUuid ?? envelope.source;
    const groupId = envelope.dataMessage.groupInfo?.groupId;
    if (!Number.isSafeInteger(timestamp) || (timestamp ?? 0) <= 0) return null;
    if (typeof source !== 'string' || source.length === 0) return null;
    if (groupId !== undefined && groupId.length === 0) return null;
    return {
      timestamp: timestamp!,
      source,
      destination: groupId ?? ownNumber,
      groupId,
      body: envelope.dataMessage.message ?? null,
      fromMe: false,
      type: 'data',
    };
  }
  return null;
}

function isTerminalTransportError(error: unknown): boolean {
  const code = (error as SignalPortError | undefined)?.code;
  return code === 'SocketError' || code === 'Closed' || code === 'Timeout';
}

export class SignalCliPort implements SignalPort {
  private readonly config: SignalConfig;
  private readonly connectionFactory: SignalRpcConnectionFactory;
  private connection: SignalRpcConnection | null = null;

  constructor(
    config: SignalConfig,
    connectionFactory: SignalRpcConnectionFactory = createSocketConnection,
  ) {
    assertEndpoint(config);
    this.config = config;
    this.connectionFactory = connectionFactory;
  }

  private conn(): SignalRpcConnection {
    if (this.connection !== null) return this.connection;
    let created: SignalRpcConnection;
    created = this.connectionFactory(this.config, () => {
      if (this.connection === created) this.connection = null;
    });
    this.connection = created;
    return created;
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const connection = this.conn();
    try {
      return await connection.request(method, params);
    } catch (error) {
      if (isTerminalTransportError(error) && this.connection === connection) {
        this.connection = null;
        connection.close();
      }
      throw error;
    }
  }

  resetConnection(): void {
    const connection = this.connection;
    this.connection = null;
    connection?.close();
  }

  dispose(): void {
    this.resetConnection();
  }

  async verifyCredentials(): Promise<void> {
    const result = await this.request('listDevices');
    if (!Array.isArray(result)) {
      throw {
        message: 'signal-cli listDevices returned a malformed response',
        code: 'MalformedResponse',
        status: 502,
      } satisfies SignalPortError;
    }
  }

  async send(args: SendSignalArgs): Promise<{ timestamp: number }> {
    if ((args.recipient === undefined) === (args.groupId === undefined)) {
      throw {
        message: 'send requires exactly one of recipient or groupId',
        code: 'BadArgs',
      } satisfies SignalPortError;
    }
    const params: Record<string, unknown> = { message: args.body };
    if (args.groupId !== undefined) params['groupId'] = args.groupId;
    if (args.recipient !== undefined) params['recipient'] = [args.recipient];
    const result = await this.request('send', params);
    const timestamp = (result as { timestamp?: unknown } | null)?.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
      throw {
        message: 'signal-cli send returned no valid canonical timestamp',
        code: 'MalformedResponse',
        status: 502,
      } satisfies SignalPortError;
    }
    return { timestamp };
  }

  async listInboundSince(since: Date, pageSize?: number): Promise<readonly InboundSignal[]> {
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize <= 0)) {
      throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
    }
    const sinceMs = since.getTime();
    if (!Number.isFinite(sinceMs)) {
      throw new RangeError('since must be a valid Date');
    }
    const limit = pageSize ?? DEFAULT_RECEIVE_PAGE_SIZE;
    const result = await this.request('receive', { timeout: 1, maxMessages: limit });
    if (!Array.isArray(result) || result.length > limit) {
      throw {
        message: 'signal-cli receive returned an invalid or oversized response',
        code: 'MalformedResponse',
        status: 502,
      } satisfies SignalPortError;
    }
    return result
      .map((wrapper) => {
        if (wrapper === null || typeof wrapper !== 'object') return null;
        const envelope = (wrapper as { envelope?: RpcEnvelope }).envelope;
        return envelope === undefined ? null : normalizeEnvelope(envelope, this.config.phoneNumber);
      })
      .filter((row): row is InboundSignal => row !== null)
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  async sendReaction(args: ReactSignalArgs): Promise<void> {
    if (args.targetInGroup) {
      throw {
        message: 'group reactions require separate conversation and target-author identities',
        code: 'BadArgs',
      } satisfies SignalPortError;
    }
    const params: Record<string, unknown> = {
      emoji: args.emoji,
      targetAuthor: args.targetAuthor,
      targetTimestamp: args.targetTimestamp,
    };
    if (args.remove) params['remove'] = true;
    params['recipients'] = [args.targetAuthor];
    await this.request('sendReaction', params);
  }

  async sendReadReceipts(args: SendReadReceiptArgs): Promise<void> {
    await this.request('sendReceipt', {
      recipient: args.target,
      type: 'read',
      targetTimestamp: args.timestamps.length === 1 ? args.timestamps[0] : [...args.timestamps],
    });
  }

  async sendTypingIndicator(args: SendTypingArgs): Promise<void> {
    if ((args.target === undefined) === (args.groupId === undefined)) {
      throw {
        message: 'sendTyping requires exactly one of target or groupId',
        code: 'BadArgs',
      } satisfies SignalPortError;
    }
    await this.request('sendTyping', {
      ...(args.target === undefined ? {} : { recipient: [args.target] }),
      ...(args.groupId === undefined ? {} : { groupId: args.groupId }),
      ...(args.composing ? {} : { stop: true }),
    });
  }

  async remoteDelete(args: RemoteDeleteSignalArgs): Promise<void> {
    if ((args.recipient === undefined) === (args.groupId === undefined)) {
      throw {
        message: 'remoteDelete requires exactly one of recipient or groupId',
        code: 'BadArgs',
      } satisfies SignalPortError;
    }
    await this.request('remoteDelete', {
      ...(args.recipient === undefined ? {} : { recipient: [args.recipient] }),
      ...(args.groupId === undefined ? {} : { groupId: args.groupId }),
      targetTimestamp: args.targetTimestamp,
    });
  }
}
