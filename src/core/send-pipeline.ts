import {
  type ChatResolver,
  type ChatTarget,
} from './chats-resolver.ts';
import {
  UnknownProfileError,
  applyProfile,
  type ProfileRegistry,
} from './profiles.ts';
import type {
  OutboundSendCaller,
  OutboundSendsWriter,
} from './outbound-sends.ts';
import { isRecord } from '../lib/type-guards.ts';
import { errorMessage } from '../lib/error-message.ts';

export type LinkPreviewMode = 'auto' | 'off';
export type TextSendTransportResult = { transportId?: string | null } | void;
export type TextSendTransport<T extends TextSendTransportResult = TextSendTransportResult> = (
  prepared: PreparedTextSend,
) => Promise<T>;

export interface ExecuteSendOptions {
  /**
   * Rewrites the prepared send before it is audited and transmitted. Runs after
   * preparation/profile application and before `beforeAudit`, so the audit row
   * and transport both see the transformed text. A transform that changes the
   * text MUST return a full `PreparedTextSend` with an updated
   * `audit.textLength` so the audit reflects what was actually sent.
   */
  transformPrepared?: (prepared: PreparedTextSend) => PreparedTextSend | Promise<PreparedTextSend>;
  beforeAudit?: (prepared: PreparedTextSend) => void | Promise<void>;
}

export interface TextSendInput extends ChatTarget {
  text?: unknown;
  link_preview?: unknown;
  profile?: unknown;
}

export interface PreparedTextSend {
  chatJid: string;
  text: string;
  linkPreviewMode: LinkPreviewMode;
  audit: {
    targetKind: 'chatJid' | 'alias';
    alias?: string;
    profile?: string;
    textLength: number;
  };
}

export class InvalidSendRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSendRequestError';
  }
}

export class MissingTextError extends Error {
  constructor() {
    super('request body must contain text');
    this.name = 'MissingTextError';
  }
}

export interface SendPipelineDeps {
  chatResolver: ChatResolver;
  profiles?: ProfileRegistry;
}

export interface SendPipeline {
  prepareSend(input: unknown): PreparedTextSend;
  executeSend<T extends TextSendTransportResult>(
    input: unknown,
    transport: TextSendTransport<T>,
    options?: ExecuteSendOptions,
  ): Promise<T>;
}

export function createSendPipeline({
  resolver,
  profiles,
  auditWriter,
  caller,
}: {
  resolver: ChatResolver;
  profiles?: ProfileRegistry;
  auditWriter?: OutboundSendsWriter;
  caller?: OutboundSendCaller;
}): SendPipeline {
  return {
    prepareSend(input: unknown): PreparedTextSend {
      return prepareTextSend(input, { chatResolver: resolver, profiles });
    },
    async executeSend<T extends TextSendTransportResult>(
      input: unknown,
      transport: TextSendTransport<T>,
      options: ExecuteSendOptions = {},
    ): Promise<T> {
      let prepared = prepareTextSend(input, { chatResolver: resolver, profiles });
      if (options.transformPrepared) {
        prepared = await options.transformPrepared(prepared);
      }
      await options.beforeAudit?.(prepared);

      let auditId: number | undefined;
      if (auditWriter) {
        if (!caller) {
          throw new InvalidSendRequestError('send audit caller is required');
        }
        auditId = auditWriter.writeIntent({
          caller,
          chatJid: prepared.chatJid,
          targetKind: prepared.audit.targetKind,
          alias: prepared.audit.alias,
          profile: prepared.audit.profile,
          text: prepared.text,
          linkPreviewMode: prepared.linkPreviewMode,
        });
      }

      try {
        const result = await transport(prepared);
        if (auditId !== undefined) {
          auditWriter!.markSuccess(auditId, extractTransportId(result));
        }
        return result;
      } catch (err) {
        if (auditId !== undefined) {
          auditWriter!.markFailure(auditId, errorMessage(err));
        }
        throw err;
      }
    },
  };
}


export function prepareTextSend(
  input: unknown,
  { chatResolver, profiles }: SendPipelineDeps,
): PreparedTextSend {
  if (!isRecord(input)) {
    throw new InvalidSendRequestError('request body must be a JSON object');
  }

  if (typeof input['text'] !== 'string' || input['text'].length === 0) {
    throw new MissingTextError();
  }

  const linkPreview = input['link_preview'];
  if (linkPreview !== undefined && linkPreview !== 'auto' && linkPreview !== 'off') {
    throw new InvalidSendRequestError('link_preview must be "auto" or "off"');
  }

  const profileName = input['profile'];
  if (profileName !== undefined && (typeof profileName !== 'string' || profileName.trim().length === 0)) {
    throw new InvalidSendRequestError('profile must be a non-empty string');
  }
  const profile = typeof profileName === 'string'
    ? profiles?.get(profileName.trim())
    : undefined;
  if (typeof profileName === 'string' && profile === undefined) {
    throw new UnknownProfileError(profileName.trim());
  }

  const target: ChatTarget = {};
  if (typeof input['chatJid'] === 'string') target.chatJid = input['chatJid'];
  if (typeof input['to'] === 'string') target.to = input['to'];

  const chatJid = chatResolver.resolve(target);
  const alias = typeof input['to'] === 'string' && input['to'].trim().length > 0
    ? input['to']
    : undefined;
  const text = profile ? applyProfile(input['text'], profile) : input['text'];

  return {
    chatJid,
    text,
    linkPreviewMode: linkPreview ?? profile?.linkPreview ?? 'auto',
    audit: {
      targetKind: alias ? 'alias' : 'chatJid',
      ...(alias ? { alias } : {}),
      ...(typeof profileName === 'string' ? { profile: profileName.trim() } : {}),
      textLength: text.length,
    },
  };
}

function extractTransportId(result: TextSendTransportResult): string | null {
  if (result && typeof result.transportId === 'string' && result.transportId.length > 0) {
    return result.transportId;
  }
  return null;
}
