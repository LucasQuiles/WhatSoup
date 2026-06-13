import { type FC, useId } from "react";
import { KPI_COLOR_TOKENS, isNeutralKpiColor, kpiStrokeColor } from "../lib/color-semantics";
import { Button } from "./primitives/Button";

interface KpiCardProps {
  value: string | number;
  label: string;
  color: string;
  onClick?: () => void;
  active?: boolean;
  sparkData?: number[];
  suffix?: string;
}

const KpiCard: FC<KpiCardProps> = ({ value, label, color, onClick, active = false, sparkData, suffix }) => {
  const strokeColor = kpiStrokeColor(color);
  const hasSparkline = sparkData && sparkData.length > 1;
  const gradientId = useId();
  const valueClassName = isNeutralKpiColor(color) ? "c-kpi-value" : `c-kpi-value ${color}`;
  const valueStyle = isNeutralKpiColor(color) ? { color: KPI_COLOR_TOKENS.neutral } : undefined;

  return (
    <Button
      variant="ghost"
      aria-pressed={active}
      onClick={onClick}
      className="cursor-pointer select-none relative overflow-hidden c-kpi-pad c-kpi-hover rounded-md"
      style={{
        background: active ? "var(--color-d3)" : "var(--color-d2)",
        border: active ? `var(--bw) solid ${strokeColor}` : "var(--bw) solid var(--b1)",
        boxShadow: active ? "var(--shadow-inset)" : "none",
      }}
    >
      <div className={valueClassName} style={valueStyle}>
        {value}
        {suffix && (
          <span className="text-data font-normal ml-[var(--bw-accent)]">
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
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={strokeColor} stopOpacity="0.15" />
              <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon
            fill={`url(#${gradientId})`}
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
    </Button>
  );
};

export default KpiCard;
