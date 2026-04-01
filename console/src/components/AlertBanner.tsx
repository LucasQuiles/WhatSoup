import { type FC } from "react";
import { AlertTriangle } from "lucide-react";

interface Alert {
  line: string;
  message: string;
}

interface AlertBannerProps {
  alerts: Alert[];
  onAlertClick?: (alert: Alert) => void;
}

const AlertBanner: FC<AlertBannerProps> = ({ alerts, onAlertClick }) => {
  if (alerts.length === 0) return null;

  return (
    <div
      className="flex items-center gap-3 flex-shrink-0"
      style={{
        padding: "var(--sp-2) var(--sp-4)",
        backgroundColor: "var(--s-crit-wash)",
        border: "var(--bw) solid var(--s-crit-border)",
        borderRadius: 'var(--radius-md)',
        fontSize: "var(--font-size-data)",
      }}
    >
      {/* Count badge */}
      <span
        className="inline-flex items-center gap-1.5 text-s-crit font-mono font-medium px-2.5 py-0.5 rounded"
        style={{ fontSize: 'var(--font-size-sm)', backgroundColor: "var(--s-crit-soft)" }}
      >
        <AlertTriangle size={12} strokeWidth={2} />
        {alerts.length} alert{alerts.length !== 1 && "s"}
      </span>

      {/* Alert chips */}
      <div className="flex items-center gap-2 overflow-x-auto">
        {alerts.map((alert) => (
          <button
            key={alert.line}
            type="button"
            onClick={() => onAlertClick?.(alert)}
            className="inline-flex items-center gap-1 text-s-crit font-mono
                       c-hover
                       rounded cursor-pointer whitespace-nowrap
                       hover:bg-[var(--s-crit-soft)]"
            style={{ fontSize: 'var(--font-size-sm)', padding: "var(--sp-1) var(--sp-3)", backgroundColor: "var(--s-crit-wash)" }}
          >
            <span className="text-t4">{alert.line}</span>
            <span className="mx-1 text-t5">—</span>
            <span>{alert.message}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default AlertBanner;
