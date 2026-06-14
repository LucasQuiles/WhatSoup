import { type FC } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Inbox,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  Download,
  Wifi,
  WifiOff,
  Sun,
  Moon,
  LogOut,
} from "lucide-react";
import { useRealtime } from "../hooks/use-websocket";
import { useTheme } from "../hooks/use-theme";
import { Button } from "./primitives/Button";
import { ActionButton } from "./primitives/ActionButton";

interface NavProps {
  alertCount?: number;
  unreadCount?: number;
  version?: string;
  updateAvailable?: boolean;
  remoteSha?: string;
  onUpdateClick?: () => void;
  /** When provided (production session mode), renders a logout control. */
  onLogout?: () => void;
}

const Nav: FC<NavProps> = ({ alertCount = 0, unreadCount = 0, version, updateAvailable, remoteSha, onUpdateClick, onLogout }) => {
  const { connected } = useRealtime();
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const isFleetActive = location.pathname === '/' || location.pathname.startsWith('/lines/');
  return (
    <nav
      role="navigation"
      aria-label="Main navigation"
      className="bg-d1 flex items-center justify-between flex-shrink-0 h-[var(--nav-h)] py-0 px-[var(--sp-3)] sm:px-[var(--sp-5)] c-border-b gap-[var(--sp-3)] sm:gap-[var(--sp-6)] min-w-0"
    >
      {/* Left cluster: logo + nav items */}
      <div className="flex items-center gap-[var(--sp-2)] sm:gap-[var(--sp-6)] min-w-0">
        <span
          className="text-xl font-sans font-black select-none tracking-[var(--tracking-tighter)]"
        >
          <span className="text-t2">What</span>
          <span className="text-s-ok">Soup</span>
        </span>

        <Link
          to="/"
          aria-current={isFleetActive ? 'page' : undefined}
          className={`text-data flex items-center gap-1.5 font-sans font-medium c-nav-link relative py-[var(--sp-1h)] px-[var(--sp-3)] rounded-sm ${
            isFleetActive
              ? "text-t1 bg-d4"
              : "text-t4 hover:text-t2"
          }`}
        >
          <LayoutDashboard size={18} strokeWidth={1.75} aria-hidden="true" />
          <span className="max-sm:sr-only">Soup Kitchen</span>
          {isFleetActive && (
            <span
              className="absolute h-[var(--bw-accent)] bg-[var(--accent)] rounded-sm"
              style={{
                bottom: "-1px",
                left: "var(--sp-3)",
                right: "var(--sp-3)",
              }}
            />
          )}
        </Link>

        <NavLink
          to="/inbox"
          className={({ isActive }) =>
            `text-data flex items-center gap-1.5 font-sans font-medium c-nav-link relative py-[var(--sp-1h)] px-[var(--sp-3)] rounded-sm ${
              isActive
                ? "text-t1 bg-d4"
                : "text-t4 hover:text-t2"
            }`
          }
        >
          {({ isActive }) => (
            <>
              <Inbox size={18} strokeWidth={1.75} aria-hidden="true" />
              <span className="max-sm:sr-only">Inbox</span>
              {unreadCount > 0 && (
                <span
                  className="text-xs font-mono font-semibold rounded-md min-w-[var(--sp-4)] text-center ml-[var(--sp-0h)] bg-[var(--accent)] text-[var(--accent-fg)] py-[var(--sp-0h)] px-[var(--sp-1)]"
                >
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
              {isActive && (
                <span
                  className="absolute h-[var(--bw-accent)] bg-[var(--accent)] rounded-sm"
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
            `text-data flex items-center gap-1.5 font-sans font-medium c-nav-link relative py-[var(--sp-1h)] px-[var(--sp-3)] rounded-sm ${
              isActive
                ? "text-t1 bg-d4"
                : "text-t4 hover:text-t2"
            }`
          }
        >
          {({ isActive }) => (
            <>
              <Terminal size={18} strokeWidth={1.75} aria-hidden="true" />
              <span className="max-sm:sr-only">Ops</span>
              {isActive && (
                <span
                  className="absolute h-[var(--bw-accent)] bg-[var(--accent)] rounded-sm"
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

      {/* Right cluster: theme toggle + system status */}
      <div className="text-xs flex items-center gap-2 font-mono flex-shrink-0">
        <ActionButton
          onClick={toggleTheme}
          label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          icon={theme === 'dark' ? <Sun size={14} strokeWidth={1.75} /> : <Moon size={14} strokeWidth={1.75} />}
          className="flex items-center justify-center w-[var(--sp-6)] h-[var(--sp-6)] rounded-sm c-hover text-t4 hover:text-t2"
        />
        {connected ? (
          <span className="flex items-center gap-1 text-s-ok" title="Realtime connected">
            <Wifi size={12} strokeWidth={1.75} />
            <span className="hidden md:inline">Live</span>
          </span>
        ) : (
          <span className="flex items-center gap-1 text-t2" title="Polling (WebSocket disconnected)">
            <WifiOff size={12} strokeWidth={1.75} />
            <span className="hidden md:inline">Polling</span>
          </span>
        )}
        <span className="text-t5 hidden md:inline">|</span>
        {alertCount === 0 ? (
          <>
            <CheckCircle2 size={14} strokeWidth={1.75} className="text-s-ok" />
            <span className="text-t4 hidden md:inline">All systems operational</span>
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
            <Button
              variant="ghost"
              onClick={onUpdateClick}
              className="flex items-center gap-1 c-hover cursor-pointer text-m-cht rounded-sm py-[var(--sp-0h)] px-[var(--sp-1h)] bg-[var(--m-cht-soft)]"
              title={`Update available: ${version} → ${remoteSha}`}
              aria-label={`Update available: ${version} to ${remoteSha}`}
              icon={<Download size={15} strokeWidth={1.75} />}
            >
              <span>{version} → {remoteSha}</span>
            </Button>
          ) : (
            <span className="text-t5 hidden md:inline" title={`Version ${version}`}>
              v{version}
            </span>
          )
        )}
        {onLogout && (
          <>
            <span className="text-t5">|</span>
            <Button
              variant="ghost"
              onClick={onLogout}
              className="flex items-center gap-1 c-hover cursor-pointer text-t4 hover:text-t2 rounded-sm py-[var(--sp-0h)] px-[var(--sp-1h)]"
              title="Lock console (revoke session)"
              aria-label="Lock console"
              icon={<LogOut size={14} strokeWidth={1.75} />}
            >
              <span>Lock</span>
            </Button>
          </>
        )}
      </div>
    </nav>
  );
};

export default Nav;
