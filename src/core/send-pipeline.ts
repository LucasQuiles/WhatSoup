import {
  type ChatResolver,
  type ChatTarget,
} from './chats-resolver.ts';
import {
  UnknownProfileError,
  applyProfile,
  type ProfileRegistry,
} from './profiles.ts';

export type LinkPreviewMode = 'auto' | 'off';

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
}

export function createSendPipeline({
  resolver,
  profiles,
}: {
  resolver: ChatResolver;
  profiles?: ProfileRegistry;
}): SendPipeline {
  return {
    prepareSend(input: unknown): PreparedTextSend {
      return prepareTextSend(input, { chatResolver: resolver, profiles });
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function prepareTextSend(
  input: unknown,
  { chatResolver, profiles }: SendPipelineDeps,
): PreparedTextSend {
  if (!isPlainRecord(input)) {
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
      textLength: text.length,
    },
  };
}
