import { type FC } from "react";

type Status = "online" | "degraded" | "unreachable";
type Size = "sm" | "md";

interface StatusDotProps {
  status: Status;
  size?: Size;
}

const sizePx: Record<Size, number> = {
  sm: 6,
  md: 8,
};

const colorMap: Record<Status, string> = {
  online: "bg-s-ok",
  degraded: "bg-s-warn",
  unreachable: "bg-s-crit",
};

const glowMap: Record<Status, string> = {
  online: "0 0 12px var(--s-ok-glow)",
  degraded: "0 0 12px var(--s-warn-glow)",
  unreachable: "0 0 12px var(--s-crit-glow)",
};

const StatusDot: FC<StatusDotProps> = ({ status, size = "md" }) => {
  const px = sizePx[size];

  return (
    <span
      className="relative inline-block flex-shrink-0"
      style={{ width: `${px}px`, height: `${px}px` }}
      aria-label={status}
    >
      {/* Dot */}
      <span
        className={`absolute inset-0 rounded-full ${colorMap[status]}`}
        style={{ boxShadow: glowMap[status] }}
      />
      {/* Expanding ring for online status */}
      {status === "online" && (
        <span
          className="absolute rounded-full animate-breathe-ring"
          style={{
            inset: "-3px",
            border: "1px solid var(--s-ok-soft)",
          }}
        />
      )}
    </span>
  );
};

export default StatusDot;
