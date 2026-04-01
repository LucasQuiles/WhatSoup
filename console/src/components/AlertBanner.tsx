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
        padding: "8px 16px",
        backgroundColor: "var(--s-crit-wash)",
        border: "1px solid rgba(252,129,129,0.1)",
        borderRadius: "6px",
        fontSize: "0.78rem",
      }}
    >
      {/* Count badge */}
      <span className="inline-flex items-center gap-1.5 bg-s-crit/20 text-s-crit font-mono text-xs font-medium px-2.5 py-0.5 rounded">
        <AlertTriangle size={12} strokeWidth={2} />
        {alerts.length} alert{alerts.length !== 1 && "s"}
      </span>

      {/* Alert chips */}
      <div className="flex items-center gap-2 overflow-x-auto">
        {alerts.map((alert, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onAlertClick?.(alert)}
            className="inline-flex items-center gap-1 text-s-crit font-mono text-xs
                       bg-s-crit/10 hover:bg-s-crit/20 transition-colors duration-200
                       rounded cursor-pointer whitespace-nowrap"
            style={{ padding: "4px 12px" }}
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
