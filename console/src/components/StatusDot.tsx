import { type FC } from "react";

type Status = "online" | "degraded" | "unreachable";
type Size = "sm" | "md";

interface StatusDotProps {
  status: Status;
  size?: Size;
}

const sizeMap: Record<Size, string> = {
  sm: "h-1.5 w-1.5", // 6px — feeds
  md: "h-2 w-2",     // 8px — tables
};

const colorMap: Record<Status, string> = {
  online: "bg-s-ok",
  degraded: "bg-s-warn",
  unreachable: "bg-s-crit",
};

const glowMap: Record<Status, string> = {
  online: "0 0 12px rgba(45,212,168,0.25)",
  degraded: "0 0 12px rgba(246,173,85,0.25)",
  unreachable: "0 0 12px rgba(252,129,129,0.25)",
};

const StatusDot: FC<StatusDotProps> = ({ status, size = "md" }) => {
  return (
    <span
      className={`
        inline-block rounded-full flex-shrink-0
        ${sizeMap[size]}
        ${colorMap[status]}
        ${status === "online" ? "animate-breathe" : ""}
      `}
      style={{ boxShadow: glowMap[status] }}
      aria-label={status}
    />
  );
};

export default StatusDot;
