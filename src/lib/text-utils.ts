/** Truncate text to stay within reranker token limits. */
export function truncateForRerank(text: string, maxChars: number = 1800): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\u2026';
}
