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
      className="bg-d1 flex items-center justify-between flex-shrink-0 h-[var(--nav-h)] py-0 px-[var(--sp-5)] c-border-b gap-[var(--sp-6)]"
    >
      {/* Left cluster: logo + nav items */}
      <div className="flex items-center gap-[var(--sp-6)]">
        <span
          className="font-sans font-black select-none tracking-[var(--tracking-tighter)]"
          style={{ fontSize: "var(--font-size-xl)" }}
        >
          <span className="text-t2">What</span>
          <span className="text-s-ok">Soup</span>
        </span>

        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `flex items-center gap-1.5 font-sans font-medium c-nav-link relative py-[var(--sp-1h)] px-[var(--sp-3)] rounded-sm ${
              isActive
                ? "text-t1 bg-d4"
                : "text-t4 hover:text-t2"
            }`
          }
          style={{ fontSize: "var(--font-size-data)" }}
        >
          {({ isActive }) => (
            <>
              <LayoutDashboard size={18} strokeWidth={1.75} />
              <span>Soup Kitchen</span>
              {isActive && (
                <span
                  className="absolute h-[var(--bw-accent)] bg-s-ok rounded-sm"
                  style={{
                    bottom: "-1px",
                    left: "var(--sp-3)",
                    right: "var(--sp-3)",
                  }}
                />
              )}
            </>
          )}
        </NavLink>

        <NavLink
          to="/inbox"
          className={({ isActive }) =>
            `flex items-center gap-1.5 font-sans font-medium c-nav-link relative py-[var(--sp-1h)] px-[var(--sp-3)] rounded-sm ${
              isActive
                ? "text-t1 bg-d4"
                : "text-t4 hover:text-t2"
            }`
          }
          style={{ fontSize: "var(--font-size-data)" }}
        >
          {({ isActive }) => (
            <>
              <Inbox size={18} strokeWidth={1.75} />
              <span>Inbox</span>
              {unreadCount > 0 && (
                <span
                  className="font-mono font-semibold rounded-md min-w-[var(--sp-4)] text-center ml-[var(--sp-0h)] bg-[var(--color-s-warn)] text-d0 py-[var(--sp-0h)] px-[var(--sp-1)]"
                  style={{ fontSize: "var(--font-size-xs)" }}
                >
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
              {isActive && (
                <span
                  className="absolute h-[var(--bw-accent)] bg-s-ok rounded-sm"
                  style={{
                    bottom: "-1px",
                    left: "var(--sp-3)",
                    right: "var(--sp-3)",
                  }}
                />
              )}
            </>
          )}
        </NavLink>

        <NavLink
          to="/ops"
          className={({ isActive }) =>
            `flex items-center gap-1.5 font-sans font-medium c-nav-link relative py-[var(--sp-1h)] px-[var(--sp-3)] rounded-sm ${
              isActive
                ? "text-t1 bg-d4"
                : "text-t4 hover:text-t2"
            }`
          }
          style={{ fontSize: "var(--font-size-data)" }}
        >
          {({ isActive }) => (
            <>
              <Terminal size={18} strokeWidth={1.75} />
              <span>Ops</span>
              {isActive && (
                <span
                  className="absolute h-[var(--bw-accent)] bg-s-ok rounded-sm"
                  style={{
                    bottom: "-1px",
                    left: "var(--sp-3)",
                    right: "var(--sp-3)",
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
              type="button"
              onClick={onUpdateClick}
              className="flex items-center gap-1 c-hover cursor-pointer text-m-cht rounded-sm py-[var(--sp-0h)] px-[var(--sp-1h)] bg-[var(--m-cht-soft)]"
              title={`Update available: ${version} → ${remoteSha}`}
              aria-label={`Update available: ${version} to ${remoteSha}`}
            >
              <Download size={15} strokeWidth={1.75} />
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
