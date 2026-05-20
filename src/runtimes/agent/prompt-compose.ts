export function composeWithExactLineDedup(sources: string[]): string {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const source of sources) {
    const lines = source.split('\n');
    for (const line of lines) {
      if (line.trim().length === 0) {
        output.push(line);
        continue;
      }
      if (seen.has(line)) continue;
      seen.add(line);
      output.push(line);
    }
  }

  return output.join('\n');
}
