import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import { WhatSoupError as AppError } from '../../../errors.ts';
import type { LLMProvider, GenerateRequest, GenerateResponse, ChatMessage } from './types.ts';
import { handleApiError } from './api-error-classifier.ts';
import { stripLoneSurrogates } from '../../../core/sanitize-surrogates.ts';

const logger = createChildLogger('anthropic-provider');

function toAnthropicMessage(m: ChatMessage): Anthropic.MessageParam {
  if (!m.images || m.images.length === 0) {
    return { role: m.role, content: m.content };
  }

  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  if (m.content) {
    content.push({ type: 'text', text: m.content });
  }
  for (const img of m.images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType as Anthropic.Base64ImageSource['media_type'],
        data: img.base64,
      },
    });
  }
  return { role: m.role, content };
}

export function createAnthropicProvider(): LLMProvider {
  const client = new Anthropic();

  return {
    name: 'anthropic',

    async generate(request: GenerateRequest): Promise<GenerateResponse> {
      const { model, maxTokens, systemPrompt, messages } = request;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);
      const signal = request.signal
        ? AbortSignal.any([request.signal, controller.signal])
        : controller.signal;

      // Defense layer: sanitize all message content to strip lone surrogates
      // that would produce invalid JSON and trigger "no low surrogate" API errors.
      const sanitizedMessages = messages.map(m => ({
        ...m,
        content: stripLoneSurrogates(m.content),
      }));
      const sanitizedSystemPrompt = stripLoneSurrogates(systemPrompt);

      const startMs = Date.now();
      let response: Anthropic.Message;
      try {
        response = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: sanitizedSystemPrompt,
            messages: sanitizedMessages.map(toAnthropicMessage),
          },
          { signal },
        );
      } catch (err) {
        handleApiError(err, 'Anthropic', model, startMs, logger);
      } finally {
        clearTimeout(timeout);
      }

      const durationMs = Date.now() - startMs;

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;

      const block = response.content[0];
      if (!block) {
        // #1064: empty content with a normal end_turn is a VALID empty reply —
        // the model chose to say nothing. max_tokens truncation (or any other
        // stop reason) with no text is still a failure.
        if (response.stop_reason !== 'end_turn') {
          logger.error(
            { model, provider: 'anthropic', stopReason: response.stop_reason, response },
            'Anthropic returned no content with a non-end_turn stop',
          );
          throw new AppError(
            `Anthropic returned no content (stop_reason: ${response.stop_reason ?? 'unknown'})`,
            'LLM_UNAVAILABLE',
          );
        }
        logger.info(
          { model, provider: 'anthropic', inputTokens, outputTokens, durationMs },
          'Anthropic returned a valid empty completion',
        );
        return { content: '', inputTokens, outputTokens, model: response.model, durationMs };
      }
      if (block.type !== 'text') {
        logger.error({ model, provider: 'anthropic', response }, 'Unexpected response shape from Anthropic');
        throw new AppError('Unexpected response shape from Anthropic', 'LLM_UNAVAILABLE');
      }

      logger.info(
        { model, provider: 'anthropic', inputTokens, outputTokens, durationMs },
        'Anthropic generate complete',
      );

      return {
        content: block.text,
        inputTokens,
        outputTokens,
        model: response.model,
        durationMs,
      };
    },
  };
}
