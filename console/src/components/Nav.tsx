import { type FC, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Inbox,
  BarChart3,
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

/** A single stacked rail row: icon + label. The active row is a full accent fill
 *  (bg --accent, dark --accent-fg text); its icon inherits accent-fg via currentColor.
 *  (Showcase-accurate; arbitrated green by the accent-law + accent-fg-on-accent contrast guards.) */
function railItemClass(isActive: boolean): string {
  return `text-data soup-rail__item c-nav-link font-sans font-medium ${
    isActive
      ? "bg-[var(--accent)] text-[var(--accent-fg)]"
      : "text-text-2 hover:text-text-2"
  }`;
}

function RailLabel({ children }: { children: ReactNode }) {
  return <span className="soup-rail__label">{children}</span>;
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
      className="soup-rail bg-surface-raised c-border-r min-w-0"
    >
      {/* SOUP nameplate — engraved instrument label, docked at the top of the rail
          (brand.md §1.1–§1.3). Lockup styled in primitives.css (.soup-nameplate*):
          teal heritage tick (--mode-passive-solid, NOT the action accent), --sp-3 gap,
          wordmark in --type-nameplate with tracking/optical-centering corrections. */}
      <div className="soup-rail__head">
        <span className="soup-nameplate" aria-label="SOUP">
          <span aria-hidden="true" className="soup-nameplate__tick" />
          <span className="soup-nameplate__wm soup-rail__label">SOUP</span>
        </span>
      </div>

      {/* Stacked primary nav items (Fleet / Inbox / Ops). Scroll-owner so a short
          viewport keeps the nameplate pinned and the bottom dock reachable. */}
      <div className="soup-rail__scroll">
        <div className="soup-rail__nav">
          <Link
            to="/"
            aria-current={isFleetActive ? 'page' : undefined}
            className={railItemClass(isFleetActive)}
          >
            <LayoutDashboard size={18} strokeWidth={1.75} aria-hidden="true" />
            <RailLabel>Fleet</RailLabel>
          </Link>

          <NavLink
            to="/inbox"
            className={({ isActive }) => railItemClass(isActive)}
          >
            {({ isActive }) => (
              <>
                <Inbox size={18} strokeWidth={1.75} aria-hidden="true" />
                <RailLabel>Inbox</RailLabel>
                {unreadCount > 0 && (
                  <>
                    <span
                      aria-hidden="true"
                      className={`text-xs font-mono font-semibold rounded-md min-w-[var(--sp-4)] text-center ml-auto py-[var(--sp-0h)] px-[var(--sp-1)] ${
                        isActive
                          ? "bg-[var(--accent-fg)] text-[var(--accent)]"
                          : "bg-[var(--accent)] text-[var(--accent-fg)]"
                      }`}
                    >
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                    <span className="sr-only">{unreadCount} unread</span>
                  </>
                )}
              </>
            )}
          </NavLink>

          <NavLink
            to="/metrics"
            className={({ isActive }) => railItemClass(isActive)}
          >
            <BarChart3 size={18} strokeWidth={1.75} aria-hidden="true" />
            <RailLabel>Metrics</RailLabel>
          </NavLink>

          <NavLink
            to="/ops"
            className={({ isActive }) => railItemClass(isActive)}
          >
            <Terminal size={18} strokeWidth={1.75} aria-hidden="true" />
            <RailLabel>Ops</RailLabel>
          </NavLink>
        </div>
      </div>

      {/* Flex spacer — pushes the secondary controls to the bottom of the rail. */}
      <div className="soup-rail__spacer" />

      {/* Bottom dock: theme toggle + realtime status + version + logout. */}
      <div className="soup-rail__dock text-xs font-mono">
        <div className="soup-rail__dock-row">
          <ActionButton
            onClick={toggleTheme}
            label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            icon={theme === 'dark' ? <Sun size={14} strokeWidth={1.75} /> : <Moon size={14} strokeWidth={1.75} />}
            className="flex items-center justify-center w-[var(--sp-6)] h-[var(--sp-6)] flex-shrink-0 rounded-sm c-hover text-text-2 hover:text-text-2"
          />
          {connected ? (
            <span className="flex items-center gap-1 text-s-ok min-w-0" title="Realtime connected">
              <Wifi size={12} strokeWidth={1.75} className="flex-shrink-0" />
              <span className="soup-rail__label">Live</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-text-2 min-w-0" title="Polling (WebSocket disconnected)">
              <WifiOff size={12} strokeWidth={1.75} className="flex-shrink-0" />
              <span className="soup-rail__label">Polling</span>
            </span>
          )}
        </div>

        <div className="soup-rail__dock-row">
          {alertCount === 0 ? (
            <>
              <CheckCircle2 size={14} strokeWidth={1.75} className="text-s-ok flex-shrink-0" />
              <span className="text-text-2 soup-rail__label">All systems operational</span>
            </>
          ) : (
            <>
              <AlertTriangle size={14} strokeWidth={1.75} className="text-s-crit flex-shrink-0" />
              <span className="text-s-crit soup-rail__label">
                {alertCount} alert{alertCount !== 1 && "s"}
              </span>
            </>
          )}
        </div>

        {version && version !== 'unknown' && (
          <div className="soup-rail__dock-row">
            {updateAvailable && remoteSha ? (
              <Button
                variant="ghost"
                onClick={onUpdateClick}
                className="flex items-center gap-1 c-hover cursor-pointer text-m-cht rounded-sm py-[var(--sp-0h)] px-[var(--sp-1h)] min-w-0 bg-[var(--m-cht-soft)]"
                title={`Update available: ${version} → ${remoteSha}`}
                aria-label={`Update available: ${version} to ${remoteSha}`}
                icon={<Download size={15} strokeWidth={1.75} />}
              >
                <span className="soup-rail__label">{version} → {remoteSha}</span>
              </Button>
            ) : (
              <span className="text-text-3 soup-rail__label" title={`Version ${version}`}>
                v{version}
              </span>
            )}
          </div>
        )}

        {onLogout && (
          <div className="soup-rail__dock-row">
            <Button
              variant="ghost"
              onClick={onLogout}
              className="flex items-center gap-1 c-hover cursor-pointer text-text-2 hover:text-text-2 rounded-sm py-[var(--sp-0h)] px-[var(--sp-1h)] min-w-0"
              title="Lock console (revoke session)"
              aria-label="Lock console"
              icon={<LogOut size={14} strokeWidth={1.75} />}
            >
              <span className="soup-rail__label">Lock</span>
            </Button>
          </div>
        )}
      </div>
    </nav>
  );
};

export default Nav;
