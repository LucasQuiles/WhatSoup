import { type FC } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Inbox,
  Terminal,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

interface NavProps {
  alertCount?: number;
  unreadCount?: number;
}

const Nav: FC<NavProps> = ({ alertCount = 0, unreadCount = 0 }) => {
  return (
    <nav
      className="bg-d1 flex items-center justify-between flex-shrink-0"
      style={{
        height: "var(--nav-h)",
        padding: "0 var(--sp-5)",
        borderBottom: "1px solid var(--b1)",
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
                    left: "12px",
                    right: "12px",
                    height: "2px",
                    background: "var(--color-s-ok)",
                    borderRadius: "1px",
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
                    padding: "1px 5px",
                    borderRadius: 'var(--radius-md)',
                    minWidth: "16px",
                    textAlign: "center",
                    marginLeft: "2px",
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
                    left: "12px",
                    right: "12px",
                    height: "2px",
                    background: "var(--color-s-ok)",
                    borderRadius: "1px",
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
                    left: "12px",
                    right: "12px",
                    height: "2px",
                    background: "var(--color-s-ok)",
                    borderRadius: "1px",
                  }}
                />
              )}
            </>
          )}
        </NavLink>
      </div>

      {/* Right cluster: system status */}
      <div className="flex items-center gap-2 font-mono" style={{ fontSize: "var(--font-size-xs)" }}>
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
      </div>
    </nav>
  );
};

export default Nav;
