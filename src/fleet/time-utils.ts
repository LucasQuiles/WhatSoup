/** Convert Unix timestamp (seconds or milliseconds) to ISO string. */
export function toIsoFromUnix(ts: number): string {
  return new Date(ts > 1e12 ? ts : ts * 1000).toISOString()
}
