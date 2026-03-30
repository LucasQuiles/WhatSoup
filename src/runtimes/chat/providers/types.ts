export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: Array<{ mimeType: string; base64: string }>;
}

export interface GenerateRequest {
  model: string;
  maxTokens: number;
  systemPrompt: string;
  messages: ChatMessage[];
}

export interface GenerateResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  durationMs: number;
}

export interface LLMProvider {
  name: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}
