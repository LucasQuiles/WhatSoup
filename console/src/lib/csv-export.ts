// ---------------------------------------------------------------------------
//  CSV export helpers for metrics data.
// ---------------------------------------------------------------------------

import type { MessageVolumeBucket } from '../types';

export function metricsToCSV(data: MessageVolumeBucket[]): string {
  const header = 'bucket,inbound,outbound';
  if (data.length === 0) return header;
  const rows = data.map((b) => `${b.bucket},${b.inbound},${b.outbound}`);
  return [header, ...rows].join('\n');
}

export function downloadCSV(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
