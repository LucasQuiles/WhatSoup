/**
 * NavRail — v3.5 global chrome rail (T5 b-02; 20-t5-cutover-plan.md).
 *
 * Operate/Create/System sections + Hosts block, nameplate with page-context
 * caps, and the utility dock (realtime status, version/update, lock) carried
 * over from the legacy Nav until the Settings surface (b-09) owns them.
 * Visual SSOT: docs/design-system/v35/mockups/*.html; styles: chrome.css.
 *
 * Active state rides aria-current="page" (set from react-router location) so
 * the visual and a11y state can never drift. Collapse ≤1100px is pure CSS.
 */
import { type FC } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Wifi, WifiOff, Download, LogOut } from 'lucide-react';
import { useRealtime } from '../../hooks/use-websocket';
import { Button } from '../primitives/Button';
import { NAV_SECTIONS, routeMeta } from './route-meta';

interface NavRailProps {
  unreadCount?: number;
  version?: string;
  updateAvailable?: boolean;
  remoteSha?: string;
  onUpdateClick?: () => void;
  /** When provided (production session mode), renders the lock control. */
  onLogout?: () => void;
}

const NavRail: FC<NavRailProps> = ({
  unreadCount = 0,
  version,
  updateAvailable,
  remoteSha,
  onUpdateClick,
  onLogout,
}) => {
  const { connected } = useRealtime();
  const location = useLocation();
  const { ctx } = routeMeta(location.pathname);

  return (
    <nav
      role="navigation"
      aria-label="Main navigation"
      className="chrome-rail min-w-0"
    >
      {/* SOUP nameplate — the spec-locked .soup-nameplate lockup (brand.md §1:
          teal heritage tick, Bricolage 800 wordmark, accent U) + the page-context
          caps (mockup .ctx). */}
      <div className="chrome-nameplate">
        <span className="soup-nameplate" aria-label="SOUP">
          <span aria-hidden="true" className="soup-nameplate__tick" />
          <span aria-hidden="true" className="soup-nameplate__wm">
            SO<span className="soup-nameplate__accent">U</span>P
          </span>
        </span>
        <span className="chrome-ctx" aria-hidden="true">
          {ctx}
        </span>
      </div>

      {/* Sections + items (Operate / Create / System). */}
      <div className="chrome-nav">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} role="group" aria-label={section.label}>
            <div className="chrome-nav-sec" aria-hidden="true">
              {section.label}
            </div>
            {section.items.map((item) => {
              const active = item.isActive(location.pathname);
              const Glyph = item.glyph;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className="chrome-nav-item"
                  title={item.label}
                >
                  <Glyph />
                  <span className="chrome-nav-item__label">{item.label}</span>
                  {item.label === 'Inbox' && unreadCount > 0 && (
                    <>
                      <span aria-hidden="true" className="chrome-attn-dot" />
                      <span className="sr-only">{unreadCount} unread</span>
                    </>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      {/* Hosts block — this console serves the local deployment; remote hosts
          arrive with the Deployments surface (b-08). */}
      <div className="chrome-hosts">
        <div className="chrome-nav-sec" aria-hidden="true">
          Hosts
        </div>
        <div className="chrome-hchip">
          <span aria-hidden="true" className="chrome-hst" />
          <span className="chrome-hchip__label">local · this host</span>
        </div>
      </div>

      {/* Utility dock — realtime status, version/update, lock. */}
      <div className="chrome-utility">
        {connected ? (
          <span className="chrome-utility-row chrome-utility-row--ok" title="Realtime connected">
            <Wifi strokeWidth={1.75} aria-hidden="true" />
            <span className="chrome-utility-row__label">Live</span>
          </span>
        ) : (
          <span
            className="chrome-utility-row chrome-utility-row--dim"
            title="Polling (WebSocket disconnected)"
          >
            <WifiOff strokeWidth={1.75} aria-hidden="true" />
            <span className="chrome-utility-row__label">Polling</span>
          </span>
        )}

        {version && version !== 'unknown' &&
          (updateAvailable && remoteSha ? (
            <Button
              variant="ghost"
              onClick={onUpdateClick}
              className="chrome-utility-row chrome-utility-row--update"
              title={`Update available: ${version} → ${remoteSha}`}
              aria-label={`Update available: ${version} to ${remoteSha}`}
              icon={<Download strokeWidth={1.75} aria-hidden="true" />}
            >
              <span className="chrome-utility-row__label">
                {version} → {remoteSha}
              </span>
            </Button>
          ) : (
            <span
              className="chrome-utility-row chrome-utility-row--recessed"
              title={`Version ${version}`}
            >
              <span className="chrome-utility-row__label">v{version}</span>
            </span>
          ))}

        {onLogout && (
          <Button
            variant="ghost"
            onClick={onLogout}
            className="chrome-utility-row chrome-utility-row--lock"
            title="Lock console (revoke session)"
            aria-label="Lock console"
            icon={<LogOut strokeWidth={1.75} aria-hidden="true" />}
          >
            <span className="chrome-utility-row__label">Lock</span>
          </Button>
        )}
      </div>
    </nav>
  );
};

export default NavRail;
