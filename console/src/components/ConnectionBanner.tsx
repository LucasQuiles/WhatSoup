import { type FC } from "react";
import { WifiOff } from "lucide-react";
import type { TransportStatus } from "../hooks/use-transport-status";

interface ConnectionBannerProps {
  /** Current transport status — drives the copy. */
  status: TransportStatus;
  /** Whether the surface is disconnected; the banner renders only when true. */
  isDisconnected: boolean;
}

/**
 * Slim, persistent, non-blocking app-level connection status bar. It is the
 * console-transport-loss surface ruled in DD-29: shown only while the console
 * is disconnected, on the WARN channel, and auto-hidden on reconnect (never
 * dismissable — it is a live status, not a notification).
 *
 * Co-signal discipline (color.md §6): the WifiOff shape + the copy carry the
 * meaning, not color alone. Spacing/edges use tokens only; no infinite motion
 * (reduced-motion safe by construction).
 */
const ConnectionBanner: FC<ConnectionBannerProps> = ({ status, isDisconnected }) => {
  if (!isDisconnected) return null;

  const message =
    status === "offline"
      ? "You're offline — changes will sync when your connection returns"
      : "Reconnecting… showing the last known data";

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-[var(--sp-2)] flex-shrink-0 rounded-md py-[var(--sp-1)] px-[var(--sp-4)] text-s-warn text-data"
      style={{
        backgroundColor: "var(--s-warn-wash)",
        borderWidth: "var(--bw)",
        borderStyle: "solid",
        borderColor: "var(--s-warn-border)",
      }}
    >
      <WifiOff size={14} strokeWidth={1.75} className="flex-shrink-0" />
      <span className="min-w-0">{message}</span>
    </div>
  );
};

export default ConnectionBanner;
