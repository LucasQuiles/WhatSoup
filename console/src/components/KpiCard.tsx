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

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        cursor-pointer select-none
        relative overflow-hidden
        c-kpi-pad c-kpi-hover
      `}
      style={{
        background: active ? "var(--color-d3)" : "var(--color-d2)",
        border: active ? `1px solid ${strokeColor}` : "1px solid var(--b1)",
        borderRadius: "var(--radius-md)",
        boxShadow: active
          ? `var(--shadow-inset)`
          : "none",
      }}
    >
      <div
        className={`c-kpi-value ${color}`}
      >
        {value}
        {suffix && (
          <span style={{ fontSize: "var(--font-size-data)", fontWeight: 400, marginLeft: "2px" }}>
            {suffix}
          </span>
        )}
      </div>
      <div
        className="c-label uppercase"
        style={{
          marginTop: "6px",
        }}
      >
        {label}
      </div>
      {sparkData && sparkData.length > 1 && (
        <svg
          className="absolute bottom-0 left-0 w-full"
          style={{ height: "var(--sparkline-h)", opacity: 0.3 }}
          preserveAspectRatio="none"
          viewBox={`0 0 ${sparkData.length - 1} 1`}
        >
          <polyline
            fill="none"
            stroke={strokeColor}
            strokeWidth="0.06"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={sparkData.map((d, i) => `${i},${1 - d}`).join(" ")}
          />
        </svg>
      )}
    </button>
  );
};

export default KpiCard;
