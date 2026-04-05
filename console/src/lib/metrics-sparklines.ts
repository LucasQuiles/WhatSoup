import type { MessageVolumeBucket } from '../types';

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values, 1);
  return values.map((value) => value / max);
}

export interface FleetMessageSparklines {
  inbound: number[];
  outbound: number[];
}

export function deriveFleetMessageSparklines(
  messageVolume: MessageVolumeBucket[] | undefined,
): FleetMessageSparklines | undefined {
  if (!messageVolume || messageVolume.length === 0) return undefined;

  const buckets = [...messageVolume].sort((a, b) => a.bucket.localeCompare(b.bucket));
  return {
    inbound: normalize(buckets.map((bucket) => bucket.inbound)),
    outbound: normalize(buckets.map((bucket) => bucket.outbound)),
  };
}
