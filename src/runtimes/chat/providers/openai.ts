import OpenAI from 'openai';
import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import { WhatSoupError as AppError } from '../../../errors.ts';
import type { LLMProvider, GenerateRequest, GenerateResponse, ChatMessage } from './types.ts';
import { handleApiError } from './api-error-classifier.ts';
import { stripLoneSurrogates } from '../../../core/sanitize-surrogates.ts';
import { resolveApiKey } from '../../../lib/api-key-resolver.ts';

const logger = createChildLogger('openai-provider');

function toOpenAIMessage(m: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (!m.images || m.images.length === 0) {
    return { role: m.role, content: m.content };
  }

  const content: Array<OpenAI.Chat.ChatCompletionContentPart> = [];
  if (m.content) {
    content.push({ type: 'text', text: m.content });
  }
  for (const img of m.images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    });
  }

  if (m.role === 'assistant') {
    return { role: 'assistant', content: content as OpenAI.Chat.ChatCompletionContentPartText[] };
  }
  return { role: 'user', content };
}

export function createOpenAIProvider(
  openaiProviderConfig?: { baseUrl?: string; apiKeyService?: string },
): LLMProvider {
  // Resolve at the provider boundary so the parent process does not need an
  // OPENAI_API_KEY entry. Omitting baseURL still preserves the SDK's normal
  // OPENAI_BASE_URL behavior for development and custom local endpoints.
  const client = new OpenAI({
    ...(openaiProviderConfig?.baseUrl ? { baseURL: openaiProviderConfig.baseUrl } : {}),
    apiKey: resolveApiKey({
      service: openaiProviderConfig?.apiKeyService,
      envVar: 'OPENAI_API_KEY',
    }) || undefined,
  });

  return {
    name: 'openai',

    async generate(request: GenerateRequest): Promise<GenerateResponse> {
      const { model, maxTokens, systemPrompt, messages } = request;

      // Sanitize message content to strip lone surrogates before SDK serialization
      const sanitizedMessages = messages.map(m => ({
        ...m,
        content: stripLoneSurrogates(m.content),
      }));
      const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: stripLoneSurrogates(systemPrompt) },
        ...sanitizedMessages.map(toOpenAIMessage),
      ];

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);

      const startMs = Date.now();
      let response: OpenAI.Chat.ChatCompletion;
      try {
        response = await client.chat.completions.create(
          {
            model,
            max_tokens: maxTokens,
            messages: chatMessages,
          },
          { signal: controller.signal },
        );
      } catch (err) {
        handleApiError(err, 'OpenAI', model, startMs, logger);
      } finally {
        clearTimeout(timeout);
      }

      const durationMs = Date.now() - startMs;

      const choice = response.choices[0];
      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;

      if (!choice?.message) {
        logger.error({ model, provider: 'openai', response }, 'Unexpected response shape from OpenAI');
        throw new AppError('Unexpected response shape from OpenAI', 'LLM_UNAVAILABLE');
      }

      const rawContent = choice.message.content;
      if (rawContent == null || rawContent === '') {
        // #1064: an empty completion with a normal stop is a VALID empty reply —
        // the model chose to say nothing. Truncation ('length') or content
        // filtering with no text is still a failure.
        if (choice.finish_reason !== 'stop') {
          logger.error(
            { model, provider: 'openai', finishReason: choice.finish_reason, response },
            'OpenAI returned no content with a non-stop finish',
          );
          throw new AppError(
            `OpenAI returned no content (finish_reason: ${choice.finish_reason ?? 'unknown'})`,
            'LLM_UNAVAILABLE',
          );
        }
        logger.info(
          { model, provider: 'openai', inputTokens, outputTokens, durationMs },
          'OpenAI returned a valid empty completion',
        );
        return { content: '', inputTokens, outputTokens, model: response.model, durationMs };
      }

      logger.info(
        { model, provider: 'openai', inputTokens, outputTokens, durationMs },
        'OpenAI generate complete',
      );

      return {
        content: rawContent,
        inputTokens,
        outputTokens,
        model: response.model,
        durationMs,
      };
    },
  };
}
