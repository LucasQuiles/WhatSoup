import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MessageVolumeBucket } from '../types';
import { AXIS_TICK, formatBucketLabel } from '../lib/chart-utils.js';

export function MetricsChart({ data }: { data: MessageVolumeBucket[] }) {
  return (
    <section className="c-card font-mono p-[var(--sp-4)] bg-d2 min-h-[var(--chart-min-h)]">
      <div className="font-mono text-t4 text-[var(--font-size-xs)] mb-[var(--sp-3)] uppercase tracking-[var(--tracking-label)]">
        Message Volume
      </div>

      <ResponsiveContainer width="100%" height={180}>
        {/* eslint-disable-next-line no-restricted-syntax -- Recharts SVG margin, not CSS */}
        <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="var(--b1)" vertical={false} />
          <XAxis
            dataKey="bucket"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: 'var(--b1)' }}
            minTickGap={24}
            tickFormatter={formatBucketLabel}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={28}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--color-d3)',
              borderWidth: 'var(--bw)',
              borderStyle: 'solid',
              borderColor: 'var(--b2)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-md)',
              fontSize: 'var(--font-size-xs)',
            }}
            labelFormatter={(value) => new Date(String(value)).toLocaleString()}
          />
          <Legend
            wrapperStyle={{
              fontSize: 'var(--font-size-xs)',
            }}
          />
          <Bar dataKey="inbound" name="Inbound" stackId="messages" fill="var(--color-m-pas)" radius={[2, 2, 0, 0]} />
          <Bar dataKey="outbound" name="Outbound" stackId="messages" fill="var(--color-m-cht)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </section>
  );
}
