/** Strip a leading markdown JSON code fence from LLM output, if present.
 * Returns the fenced block's trimmed contents, or the original string unchanged
 * when no fence is found. Matches an optional `json` language tag and a single
 * optional leading newline; only the first fenced block is extracted. */
export function stripJsonFences(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return fenceMatch ? fenceMatch[1].trim() : raw;
}
