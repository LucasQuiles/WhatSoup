// P3.6-H1: maximum length of rawOutput preserved on error details.
// 500 chars is enough to diagnose schema drift without leaking conversation content.
// PII hygiene: rawOutput in ExtractionError.details and ValidationError.details is truncated here.

export const RAW_OUTPUT_TRUNCATE = 500;

export function truncateRaw(raw: string): string {
  return raw.length > RAW_OUTPUT_TRUNCATE ? raw.slice(0, RAW_OUTPUT_TRUNCATE) : raw;
}
