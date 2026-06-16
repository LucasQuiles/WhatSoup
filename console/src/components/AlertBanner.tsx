import { type FC } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./primitives/Button";

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
      role="alert"
      aria-live="assertive"
      className="flex items-center gap-3 flex-shrink-0 rounded-md py-[var(--sp-2)] px-[var(--sp-4)] text-data"
      style={{
        backgroundColor: "var(--s-crit-wash)",
        borderWidth: "var(--bw)", borderStyle: "solid", borderColor: "var(--s-crit-border)",
      }}
    >
      {/* Count badge */}
      <span
        className="inline-flex items-center gap-1.5 text-s-crit font-mono font-medium px-2.5 py-0.5 rounded text-sm"
        style={{ backgroundColor: "var(--s-crit-soft)" }}
      >
        <AlertTriangle size={12} strokeWidth={1.75} />
        {alerts.length} alert{alerts.length !== 1 && "s"}
      </span>

      {/* Alert chips */}
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
        {alerts.map((alert) => (
          <Button
            key={alert.line}
            variant="ghost"
            onClick={() => onAlertClick?.(alert)}
            title={`${alert.line}: ${alert.message}`}
            className="inline-flex items-center gap-1 text-s-crit font-mono c-hover rounded cursor-pointer whitespace-nowrap hover:bg-[var(--s-crit-soft)] py-[var(--sp-1)] px-[var(--sp-3)] text-sm"
            style={{ backgroundColor: "var(--s-crit-wash)" }}
          >
            <span className="text-t4">{alert.line}</span>
            <span className="mx-1 text-t5">—</span>
            <span>{alert.message}</span>
          </Button>
        ))}
      </div>
    </div>
  );
};

export default AlertBanner;
