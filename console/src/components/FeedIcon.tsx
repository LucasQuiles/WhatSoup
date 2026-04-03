import { type FC } from "react";
import {
  Plug, WifiOff, Wifi,
  ArrowDownLeft, ArrowUpRight,
  AlertTriangle,
  Terminal,
  HeartPulse,
  Database,
  CircleDot,
} from "lucide-react";
import type { FeedEvent } from "../types";

const ICON_SIZE = 14;
const STROKE = 1.75;

interface FeedIconProps {
  event: FeedEvent;
}

const FeedIcon: FC<FeedIconProps> = ({ event }) => {
  const d = event.detail;
  if (!d) return <CircleDot size={ICON_SIZE} strokeWidth={STROKE} className="text-t5" />;

  switch (d.type) {
    case "connection": {
      if (d.state === "connected") return <Wifi size={ICON_SIZE} strokeWidth={STROKE} className="text-s-ok" />;
      if (d.state === "disconnected" || (d.statusCode && !d.reconnecting && d.state !== "connected"))
        return <WifiOff size={ICON_SIZE} strokeWidth={STROKE} className="text-s-crit" />;
      if (d.reconnecting) return <Plug size={ICON_SIZE} strokeWidth={STROKE} className="text-s-warn" />;
      if (d.state === "connecting") return <Plug size={ICON_SIZE} strokeWidth={STROKE} className="text-t4" />;
      return <Plug size={ICON_SIZE} strokeWidth={STROKE} className="text-t4" />;
    }
    case "message":
      return d.direction === "inbound"
        ? <ArrowDownLeft size={ICON_SIZE} strokeWidth={STROKE} className="text-m-cht" />
        : <ArrowUpRight size={ICON_SIZE} strokeWidth={STROKE} className="text-m-agt" />;
    case "tool_error":
      return <AlertTriangle size={ICON_SIZE} strokeWidth={STROKE} className="text-s-crit" />;
    case "tool_use":
      return <Terminal size={ICON_SIZE} strokeWidth={STROKE} className="text-m-agt" />;
    case "session":
      return <Terminal size={ICON_SIZE} strokeWidth={STROKE} className="text-m-agt" />;
    case "health": {
      const color = d.status === "online" ? "text-s-ok" : d.status === "unreachable" ? "text-s-crit" : "text-s-warn";
      return <HeartPulse size={ICON_SIZE} strokeWidth={STROKE} className={color} />;
    }
    case "import":
      return <Database size={ICON_SIZE} strokeWidth={STROKE} className="text-t4" />;
    case "generic":
    default:
      return <CircleDot size={ICON_SIZE} strokeWidth={STROKE} className="text-t5" />;
  }
};

export default FeedIcon;
