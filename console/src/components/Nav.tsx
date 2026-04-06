import { type FC } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Inbox,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  Download,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useRealtime } from "../hooks/use-websocket";

interface NavProps {
  alertCount?: number;
  unreadCount?: number;
  version?: string;
  updateAvailable?: boolean;
  remoteSha?: string;
  onUpdateClick?: () => void;
}

const Nav: FC<NavProps> = ({ alertCount = 0, unreadCount = 0, version, updateAvailable, remoteSha, onUpdateClick }) => {
  const { connected } = useRealtime();
  return (
    <nav
      role="navigation"
      aria-label="Main navigation"
      className="bg-d1 flex items-center justify-between flex-shrink-0"
      style={{
        height: "var(--nav-h)",
        padding: "0 var(--sp-5)",
        borderBottom: "var(--bw) solid var(--b1)",
        gap: "var(--sp-6)",
      }}
    >
      {/* Left cluster: logo + nav items */}
      <div className="flex items-center" style={{ gap: "var(--sp-6)" }}>
        <span
          className="font-sans font-black select-none"
          style={{ fontSize: "var(--font-size-xl)", letterSpacing: "var(--tracking-tighter)" }}
        >
          <span className="text-t2">What</span>
          <span className="text-s-ok">Soup</span>
        </span>

        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `flex items-center gap-1.5 font-sans font-medium c-nav-link relative ${
              isActive
                ? "text-t1 bg-d4"
                : "text-t4 hover:text-t2"
            }`
          }
          style={{ padding: "var(--sp-1h) var(--sp-3)", fontSize: "var(--font-size-data)", borderRadius: "var(--radius-sm)" }}
        >
          {({ isActive }) => (
            <>
              <LayoutDashboard size={18} strokeWidth={1.75} />
              <span>Soup Kitchen</span>
              {isActive && (
                <span
                  className="absolute"
                  style={{
                    bottom: "-1px",
                    left: "var(--sp-3)",
                    right: "var(--sp-3)",
                    height: "var(--bw-accent)",
                    background: "var(--color-s-ok)",
                    borderRadius: "var(--radius-sm)",
                  }}
                />
              )}
            </>
          )}
        </NavLink>

        <NavLink
          to="/inbox"
          className={({ isActive }) =>
            `flex items-center gap-1.5 font-sans font-medium c-nav-link relative ${
              isActive
                ? "text-t1 bg-d4"
                : "text-t4 hover:text-t2"
            }`
          }
          style={{ padding: "var(--sp-1h) var(--sp-3)", fontSize: "var(--font-size-data)", borderRadius: "var(--radius-sm)" }}
        >
          {({ isActive }) => (
            <>
              <Inbox size={18} strokeWidth={1.75} />
              <span>Inbox</span>
              {unreadCount > 0 && (
                <span
                  className="font-mono font-semibold"
                  style={{
                    fontSize: "var(--font-size-xs)",
                    background: "var(--color-s-warn)",
                    color: "var(--color-d0)",
                    padding: "1px var(--sp-1)",
                    borderRadius: 'var(--radius-md)',
                    minWidth: "var(--sp-4)",
                    textAlign: "center",
                    marginLeft: "var(--sp-0h)",
                  }}
                >
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
              {isActive && (
                <span
                  className="absolute"
                  style={{
                    bottom: "-1px",
                    left: "var(--sp-3)",
                    right: "var(--sp-3)",
                    height: "var(--bw-accent)",
                    background: "var(--color-s-ok)",
                    borderRadius: "var(--radius-sm)",
                  }}
                />
              )}
            </>
          )}
        </NavLink>

        <NavLink
          to="/ops"
          className={({ isActive }) =>
            `flex items-center gap-1.5 font-sans font-medium c-nav-link relative ${
              isActive
                ? "text-t1 bg-d4"
                : "text-t4 hover:text-t2"
            }`
          }
          style={{ padding: "var(--sp-1h) var(--sp-3)", fontSize: "var(--font-size-data)", borderRadius: "var(--radius-sm)" }}
        >
          {({ isActive }) => (
            <>
              <Terminal size={18} strokeWidth={1.75} />
              <span>Ops</span>
              {isActive && (
                <span
                  className="absolute"
                  style={{
                    bottom: "-1px",
                    left: "var(--sp-3)",
                    right: "var(--sp-3)",
                    height: "var(--bw-accent)",
                    background: "var(--color-s-ok)",
                    borderRadius: "var(--radius-sm)",
                  }}
                />
              )}
            </>
          )}
        </NavLink>
      </div>

      {/* Right cluster: system status */}
      <div className="flex items-center gap-2 font-mono" style={{ fontSize: "var(--font-size-xs)" }}>
        {connected ? (
          <span className="flex items-center gap-1 text-s-ok" title="Realtime connected">
            <Wifi size={12} strokeWidth={1.75} />
            <span>Live</span>
          </span>
        ) : (
          <span className="flex items-center gap-1 text-t5" title="Polling (WebSocket disconnected)">
            <WifiOff size={12} strokeWidth={1.75} />
            <span>Polling</span>
          </span>
        )}
        <span className="text-t5">|</span>
        {alertCount === 0 ? (
          <>
            <CheckCircle2 size={14} strokeWidth={1.75} className="text-s-ok" />
            <span className="text-t4">All systems operational</span>
          </>
        ) : (
          <>
            <AlertTriangle size={14} strokeWidth={1.75} className="text-s-crit" />
            <span className="text-s-crit">
              {alertCount} alert{alertCount !== 1 && "s"}
            </span>
          </>
        )}
        {version && version !== 'unknown' && (
          updateAvailable && remoteSha ? (
            <button
              onClick={onUpdateClick}
              className="flex items-center gap-1 c-hover cursor-pointer"
              style={{
                color: 'var(--color-m-cht)',
                padding: '2px var(--sp-1h)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--m-cht-soft)',
              }}
              title={`Update available: ${version} → ${remoteSha}`}
              aria-label={`Update available: ${version} to ${remoteSha}`}
            >
              <Download size={12} strokeWidth={2} />
              <span>{version} → {remoteSha}</span>
            </button>
          ) : (
            <span className="text-t5" title={`Version ${version}`}>
              v{version}
            </span>
          )
        )}
      </div>
    </nav>
  );
};

export default Nav;
