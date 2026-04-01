import { type FC, useState, useMemo, Fragment } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { motion } from "framer-motion";
import { useLines, useFeed } from "../hooks/use-fleet";
import { computeKpis } from "../mock-data";
import type { Mode, LineInstance } from "../mock-data";
import KpiCard from "../components/KpiCard";
import AlertBanner from "../components/AlertBanner";
import ActivityFeed from "../components/ActivityFeed";
import StatusDot from "../components/StatusDot";
import ModeBadge from "../components/ModeBadge";
import HeartbeatStrip from "../components/HeartbeatStrip";

const ease = [0.22, 1, 0.36, 1] as const;

type KpiFilter = "connected" | "attention" | "unread" | "agent" | "messages" | null;

const modeFilterOptions: (Mode | "all")[] = ["all", "passive", "chat", "agent"];

const modeTextClass: Record<Mode, string> = {
  passive: "text-m-pas",
  chat: "text-m-cht",
  agent: "text-m-agt",
};

function pipelineText(line: LineInstance): string {
  if (line.mode === "passive") return line.unread ? `${line.unread} unread` : "—";
  if (line.mode === "chat") {
    const parts: string[] = [];
    if (line.queueDepth) parts.push(`queued: ${line.queueDepth}`);
    if (line.enrichmentUnprocessed) parts.push(`enrich: ${line.enrichmentUnprocessed}`);
    return parts.length ? parts.join(' | ') : 'idle';
  }
  if (line.mode === "agent") {
    if (line.activeSessions) return `${line.activeSessions} session${line.activeSessions > 1 ? 's' : ''} active`;
    return line.lastSessionStatus === 'auth_expired' ? 'auth expired' : 'idle';
  }
  return "—";
}

function pipelineColor(line: LineInstance): string {
  if (line.mode === "passive") return (line.unread ?? 0) > 0 ? "text-s-warn" : "text-t5";
  if (line.status === 'unreachable') return "text-s-crit";
  if (line.status === 'degraded') return "text-s-warn";
  return modeTextClass[line.mode];
}


const SoupKitchen: FC = () => {
  const { data: lines = [] } = useLines();
  const { data: feed = [] } = useFeed();
  const navigate = useNavigate();

  const [activeKpi, setActiveKpi] = useState<KpiFilter>(null);
  const [modeFilter, setModeFilter] = useState<Mode | "all">("all");
  const [search, setSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const kpis = useMemo(() => computeKpis(lines), [lines]);

  // Derive alerts from lines
  const alerts = useMemo(
    () =>
      lines
        .filter((l) => l.status === "unreachable" || l.status === "degraded")
        .map((l) => ({
          line: l.name,
          message:
            l.status === "unreachable"
              ? l.lastSessionStatus === "auth_expired" ? "auth expired" : "connection lost"
              : "degraded",
        })),
    [lines]
  );

  // Mode counts
  const modeCounts = useMemo(() => {
    const counts: Record<Mode | "all", number> = {
      all: lines.length,
      passive: 0,
      chat: 0,
      agent: 0,
    };
    for (const l of lines) counts[l.mode]++;
    return counts;
  }, [lines]);

  // Filter lines
  const filtered = useMemo(() => {
    let result = lines;

    // KPI filter
    if (activeKpi === "connected")
      result = result.filter((l) => l.status === "online");
    else if (activeKpi === "attention")
      result = result.filter(
        (l) => l.status === "unreachable" || l.status === "degraded"
      );
    else if (activeKpi === "unread")
      result = result.filter((l) => (l.unread ?? 0) > 0);
    else if (activeKpi === "agent")
      result = result.filter((l) => l.mode === "agent");
    else if (activeKpi === "messages")
      result = result.filter((l) => (l.messagesToday ?? 0) > 0);

    // Mode filter
    if (modeFilter !== "all")
      result = result.filter((l) => l.mode === modeFilter);

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (l) =>
          l.name.toLowerCase().includes(q) ||
          (l.phone ?? "").toLowerCase().includes(q)
      );
    }

    return result;
  }, [lines, activeKpi, modeFilter, search]);

  const grouped = useMemo(() => {
    const groups: { name: string; lines: typeof filtered }[] = [];
    const seen = new Set<string>();
    for (const line of filtered) {
      const g = line.group || 'Other';
      if (!seen.has(g)) {
        seen.add(g);
        groups.push({ name: g, lines: [] });
      }
      groups.find(gr => gr.name === g)!.lines.push(line);
    }
    return groups;
  }, [filtered]);

  function toggleGroup(groupName: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  }

  function toggleKpi(key: KpiFilter) {
    setActiveKpi((prev) => (prev === key ? null : key));
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* KPI Strip — Grafana-style stat cards with sparklines */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="flex flex-shrink-0"
        style={{
          gap: "1px",
          backgroundColor: "var(--color-d5)",
          borderBottom: "1px solid var(--b1)",
        }}
      >
        <KpiCard
          value={kpis.connected}
          label="Lines Connected"
          color="text-s-ok"
          onClick={() => toggleKpi("connected")}
          active={activeKpi === "connected"}
          sparkData={[0.6, 0.65, 0.7, 0.68, 0.75, 0.72, 0.8, 0.85, 0.82, 0.9, 0.88, 0.95]}
        />
        <KpiCard
          value={kpis.needAttention}
          label="Need Attention"
          color="text-s-crit"
          onClick={() => toggleKpi("attention")}
          active={activeKpi === "attention"}
        />
        <KpiCard
          value={kpis.unread}
          label="Unread (Passive)"
          color="text-s-warn"
          onClick={() => toggleKpi("unread")}
          active={activeKpi === "unread"}
          sparkData={[0.9, 0.75, 0.8, 0.6, 0.65, 0.45, 0.5, 0.35, 0.55, 0.25, 0.4]}
        />
        <KpiCard
          value={kpis.agentSessions}
          label="Agent Sessions"
          color="text-m-agt"
          onClick={() => toggleKpi("agent")}
          active={activeKpi === "agent"}
        />
        <KpiCard
          value={kpis.messagesToday.toLocaleString()}
          label="Messages Today"
          color="text-m-cht"
          onClick={() => toggleKpi("messages")}
          active={activeKpi === "messages"}
          sparkData={[0.8, 0.65, 0.7, 0.45, 0.55, 0.35, 0.5, 0.25, 0.4, 0.15, 0.25]}
        />
        <KpiCard
          value={kpis.avgResponseMs}
          suffix="ms"
          label="Avg Response"
          color="text-t2"
          sparkData={[0.5, 0.55, 0.45, 0.5, 0.38, 0.55, 0.45, 0.5, 0.38, 0.45, 0.5]}
        />
      </motion.div>

      {/* Alert Banner */}
      <AlertBanner alerts={alerts} />

      {/* Main area */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.1, ease }}
        className="flex flex-1 min-h-0"
      >
        {/* Connection Table */}
        <div
          className="flex flex-col min-h-0"
          style={{ flex: 3, borderRight: "1px solid var(--b1)" }}
        >
          {/* Toolbar */}
          <div
            className="flex items-center justify-between px-6 py-3 flex-shrink-0 bg-d3"
            style={{ borderBottom: "1px solid var(--b1)" }}
          >
            <div className="flex items-center gap-4">
              <h2
                className="font-sans font-semibold text-t1"
                style={{ fontSize: "0.82rem" }}
              >
                Connections
              </h2>

              {/* Mode filter pills */}
              <div className="flex gap-1">
                {modeFilterOptions.map((m) => {
                  const isActive = modeFilter === m;
                  const colorClass =
                    m === "all"
                      ? "text-t2"
                      : modeTextClass[m];
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setModeFilter(m)}
                      className={`
                        font-mono cursor-pointer transition-all duration-200
                        rounded bg-transparent
                        ${
                          isActive
                            ? `${colorClass} bg-d4`
                            : "text-t5 hover:text-t3 hover:bg-d3"
                        }
                      `}
                      style={{
                        fontSize: "0.7rem",
                        padding: "4px 12px",
                        border: isActive
                          ? `1px solid ${m === "passive" ? "var(--color-m-pas)" : m === "chat" ? "var(--color-m-cht)" : m === "agent" ? "var(--color-m-agt)" : "var(--b4)"}`
                          : "1px solid var(--b2)",
                      }}
                    >
                      {m === "all" ? "All" : m}
                      <span className="ml-1 text-t5">{modeCounts[m]}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Search */}
            <div className="relative">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-t5"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search lines..."
                className="bg-d1 text-t2 font-mono rounded pl-8 pr-3 py-1.5 outline-none
                           placeholder:text-t5 focus:ring-1 focus:ring-m-cht/30"
                style={{
                  fontSize: "0.75rem",
                  border: "1px solid var(--b1)",
                  width: "200px",
                }}
              />
            </div>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-y-auto">
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr
                  className="sticky top-0 bg-d3 z-10"
                  style={{ borderBottom: "1px solid var(--b2)" }}
                >
                  {[
                    { label: "", w: "36px" },
                    { label: "Line", w: undefined },
                    { label: "Mode", w: "100px" },
                    { label: "Health", w: "100px" },
                    { label: "Pipeline", w: undefined },
                    { label: "Unread", w: "72px" },
                    { label: "Last Active", w: "100px" },
                  ].map((h) => (
                    <th
                      key={h.label || "status"}
                      className="text-left font-mono text-t5 font-medium"
                      style={{
                        fontSize: "0.65rem",
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                        padding: "10px 16px",
                        width: h.w,
                      }}
                    >
                      {h.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grouped.map((group) => {
                  const isCollapsed = collapsedGroups.has(group.name);
                  return (
                    <Fragment key={group.name}>
                      <tr
                        className="bg-d3 cursor-pointer hover:bg-d4"
                        style={{ borderBottom: '1px solid var(--b1)' }}
                        onClick={() => toggleGroup(group.name)}
                      >
                        <td
                          colSpan={7}
                          className="font-mono text-t4 font-semibold"
                          style={{ fontSize: '0.75rem', padding: '8px 16px', letterSpacing: '0.04em', textTransform: 'uppercase' }}
                        >
                          <span className="text-t5 mr-2">{isCollapsed ? '▶' : '▼'}</span>
                          {group.name} ({group.lines.length} lines)
                        </td>
                      </tr>
                      {!isCollapsed && group.lines.map((line) => {
                        const isError = line.status === "unreachable";
                        return (
                          <tr
                            key={line.name}
                            onClick={() => navigate(`/lines/${line.name}`)}
                            className="cursor-pointer transition-colors duration-150 hover:bg-d4"
                            style={{
                              borderBottom: "1px solid var(--b1)",
                              ...(isError
                                ? { backgroundColor: "var(--s-crit-wash)" }
                                : {}),
                            }}
                          >
                            {/* Status */}
                            <td style={{ padding: "10px 16px" }}>
                              <StatusDot status={line.status} size="md" />
                            </td>

                            {/* Line name + phone */}
                            <td style={{ padding: "10px 16px" }}>
                              <div className="flex flex-col">
                                <span
                                  className="font-sans font-medium text-t1"
                                  style={{ fontSize: "0.82rem" }}
                                >
                                  {line.name}
                                </span>
                                <span
                                  className="font-mono text-t5"
                                  style={{ fontSize: "0.7rem" }}
                                >
                                  {line.phone}
                                </span>
                              </div>
                            </td>

                            {/* Mode */}
                            <td style={{ padding: "10px 16px" }}>
                              <ModeBadge mode={line.mode} />
                            </td>

                            {/* Health */}
                            <td style={{ padding: "10px 16px" }}>
                              <HeartbeatStrip beats={line.heartbeat ?? []} />
                            </td>

                            {/* Pipeline */}
                            <td style={{ padding: "10px 16px" }}>
                              <span
                                className={`font-mono ${pipelineColor(line)}`}
                                style={{ fontSize: "0.75rem" }}
                              >
                                {pipelineText(line)}
                              </span>
                            </td>

                            {/* Unread */}
                            <td style={{ padding: "10px 16px" }}>
                              {(line.unread ?? 0) > 0 ? (
                                <span
                                  className="font-mono text-s-warn font-medium"
                                  style={{ fontSize: "0.8rem" }}
                                >
                                  {line.unread}
                                </span>
                              ) : (
                                <span className="font-mono text-t5" style={{ fontSize: "0.8rem" }}>
                                  —
                                </span>
                              )}
                            </td>

                            {/* Last Active */}
                            <td style={{ padding: "10px 16px" }}>
                              <span
                                className={`font-mono ${isError ? "text-s-crit" : "text-t4"}`}
                                style={{ fontSize: "0.75rem" }}
                              >
                                {line.lastActive ?? "—"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}

                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="text-center text-t5 font-mono py-12"
                      style={{ fontSize: "0.8rem" }}
                    >
                      No connections match the current filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Activity Feed */}
        <div
          className="bg-d1 flex flex-col min-h-0"
          style={{ flex: 1.2, minWidth: "280px" }}
        >
          <ActivityFeed events={feed} />
        </div>
      </motion.div>
    </div>
  );
};

export default SoupKitchen;
