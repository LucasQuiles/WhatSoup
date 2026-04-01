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
        height: "52px",
        padding: "0 40px",
        borderBottom: "1px solid var(--b1)",
      }}
    >
      {/* Left cluster: logo + nav items */}
      <div className="flex items-center" style={{ gap: "24px" }}>
        <span
          className="font-sans font-extrabold text-m-cht select-none"
          style={{ fontSize: "1.1rem", letterSpacing: "-0.02em" }}
        >
          WhatSoup
        </span>

        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `flex items-center gap-1.5 font-sans transition-colors duration-200 pb-px ${
              isActive
                ? "text-t1 border-b-2 border-m-cht"
                : "text-t4 border-b-2 border-transparent hover:text-t2"
            }`
          }
          style={{ height: "52px", display: "flex", alignItems: "center", fontSize: "0.85rem" }}
        >
          <LayoutDashboard size={18} strokeWidth={1.75} />
          <span>Soup Kitchen</span>
        </NavLink>

        <NavLink
          to="/inbox"
          className={({ isActive }) =>
            `flex items-center gap-1.5 font-sans transition-colors duration-200 pb-px ${
              isActive
                ? "text-t1 border-b-2 border-m-cht"
                : "text-t4 border-b-2 border-transparent hover:text-t2"
            }`
          }
          style={{ height: "52px", display: "flex", alignItems: "center", fontSize: "0.85rem" }}
        >
          <Inbox size={18} strokeWidth={1.75} />
          <span>Inbox</span>
          {unreadCount > 0 && (
            <span
              className="font-mono font-semibold"
              style={{
                fontSize: "0.55rem",
                background: "var(--color-s-warn)",
                color: "var(--color-d0)",
                padding: "1px 5px",
                borderRadius: "6px",
                minWidth: "16px",
                textAlign: "center",
                marginLeft: "2px",
              }}
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </NavLink>

        <NavLink
          to="/ops"
          className={({ isActive }) =>
            `flex items-center gap-1.5 font-sans transition-colors duration-200 pb-px ${
              isActive
                ? "text-t1 border-b-2 border-m-cht"
                : "text-t4 border-b-2 border-transparent hover:text-t2"
            }`
          }
          style={{ height: "52px", display: "flex", alignItems: "center", fontSize: "0.85rem" }}
        >
          <Terminal size={18} strokeWidth={1.75} />
          <span>Ops</span>
        </NavLink>
      </div>

      {/* Right cluster: system status */}
      <div className="flex items-center gap-2 font-mono text-xs">
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
