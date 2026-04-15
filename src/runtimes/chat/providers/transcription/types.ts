export const FALLBACK_TEXT = '[🎤 Voice note received — transcription unavailable]';

export interface TranscriptionProvider {
  name: string;
  isAvailable(): boolean;
  transcribe(buffer: Buffer, mimeType: string): Promise<string>;
}
