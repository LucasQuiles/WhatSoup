import { type FC } from "react";

interface KpiCardProps {
  value: string | number;
  label: string;
  color: string;
  onClick?: () => void;
  active?: boolean;
  sparkData?: number[];
  suffix?: string;
}

const colorMap: Record<string, string> = {
  "text-s-ok": "var(--color-s-ok)",
  "text-s-crit": "var(--color-s-crit)",
  "text-s-warn": "var(--color-s-warn)",
  "text-m-agt": "var(--color-m-agt)",
  "text-m-cht": "var(--color-m-cht)",
  "text-m-pas": "var(--color-m-pas)",
  "text-t2": "var(--color-t2)",
};

const KpiCard: FC<KpiCardProps> = ({ value, label, color, onClick, active = false, sparkData, suffix }) => {
  const strokeColor = colorMap[color] || "currentColor";
  const hasSparkline = sparkData && sparkData.length > 1;

  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer select-none relative overflow-hidden c-kpi-pad c-kpi-hover rounded-md"
      style={{
        background: active ? "var(--color-d3)" : "var(--color-d2)",
        border: active ? `var(--bw) solid ${strokeColor}` : "var(--bw) solid var(--b1)",
        boxShadow: active ? "var(--shadow-inset)" : "none",
      }}
    >
      <div className={`c-kpi-value ${color}`}>
        {value}
        {suffix && (
          <span className="font-normal ml-[var(--bw-accent)]" style={{ fontSize: "var(--font-size-data)" }}>
            {suffix}
          </span>
        )}
      </div>
      <div className="c-label uppercase mt-[var(--sp-1h)]">
        {label}
      </div>
      {hasSparkline && (
        <svg
          className="absolute bottom-0 left-0 w-full h-[var(--sparkline-h)]"
          preserveAspectRatio="none"
          viewBox={`0 0 ${sparkData.length - 1} 1`}
        >
          <defs>
            <linearGradient id={`spark-fill-${label.replace(/\s/g, '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={strokeColor} stopOpacity="0.15" />
              <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon
            fill={`url(#spark-fill-${label.replace(/\s/g, '')})`}
            points={`0,1 ${sparkData.map((d, i) => `${i},${1 - d}`).join(" ")} ${sparkData.length - 1},1`}
          />
          <polyline
            fill="none"
            stroke={strokeColor}
            strokeWidth="0.06"
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ opacity: "var(--opacity-soft)" }}
            points={sparkData.map((d, i) => `${i},${1 - d}`).join(" ")}
          />
        </svg>
      )}
    </button>
  );
};

export default KpiCard;
