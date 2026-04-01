import { type FC, useState, useMemo } from "react";
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
import FilterPill from "../components/FilterPill";
import { formatRelative } from "../lib/format-time";
import { formatPhone, displayInstanceName } from "../lib/text-utils";

const ease = [0.22, 1, 0.36, 1] as const;

type KpiFilter = "connected" | "attention" | "unread" | "agent" | "messages" | null;

const modeFilterOptions: (Mode | "all")[] = ["all", "passive", "chat", "agent"];

const modeTextClass: Record<Mode, string> = {
  passive: "text-m-pas",
  chat: "text-m-cht",
  agent: "text-m-agt",
};

function pipelineText(line: LineInstance): string {
  if (line.mode === "passive") return "—";
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

  const kpis = useMemo(() => computeKpis(lines), [lines]);

  // Derive sparkline data from per-line heartbeat arrays
  const sparkConnected = useMemo(() => {
    if (!lines.length) return undefined;
    // Normalize message counts across lines as a sparkline
    const vals = lines.map(l => l.messagesToday ?? 0);
    const max = Math.max(...vals, 1);
    return vals.map(v => v / max);
  }, [lines]);

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

  function toggleKpi(key: KpiFilter) {
    setActiveKpi((prev) => (prev === key ? null : key));
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden" style={{ padding: "var(--sp-4)", gap: "var(--sp-3)" }}>
      {/* KPI Strip — Grafana-style stat cards with sparklines */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="flex-shrink-0"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: "var(--sp-2)",
          background: "var(--color-d1)",
          border: "var(--bw) solid var(--b1)",
          borderRadius: "var(--radius-lg)",
          padding: "var(--sp-2)",
        }}
      >
        <KpiCard
          value={kpis.connected}
          label="Lines Connected"
          color="text-s-ok"
          onClick={() => toggleKpi("connected")}
          active={activeKpi === "connected"}
          sparkData={sparkConnected}
        />
        <KpiCard
          value={kpis.needAttention}
          label="Need Attention"
          color="text-s-crit"
          onClick={() => toggleKpi("attention")}
          active={activeKpi === "attention"}
        />
        <KpiCard
          value={kpis.totalSent.toLocaleString()}
          label="Messages Sent"
          color="text-m-cht"
          onClick={() => toggleKpi("messages")}
          active={activeKpi === "messages"}
        />
        <KpiCard
          value={kpis.totalReceived.toLocaleString()}
          label="Messages Received"
          color="text-t2"
          onClick={() => toggleKpi("messages")}
          active={activeKpi === "messages"}
        />
        <KpiCard
          value={kpis.agentSessions}
          label="Agent Sessions"
          color="text-m-agt"
          onClick={() => toggleKpi("agent")}
          active={activeKpi === "agent"}
        />
        <KpiCard
          value={kpis.unread}
          label="Unread"
          color="text-s-warn"
          onClick={() => toggleKpi("unread")}
          active={activeKpi === "unread"}
        />
        <KpiCard
          value={kpis.totalMedia.toLocaleString()}
          label="Media Processed"
          color="text-s-ok"
          onClick={() => toggleKpi("messages")}
          active={activeKpi === "messages"}
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
        style={{ gap: "var(--sp-3)" }}
      >
        {/* Connection Table */}
        <div
          className="flex flex-col min-h-0"
          style={{
            flex: 3,
            background: "var(--color-d2)",
            border: "var(--bw) solid var(--b1)",
            borderRadius: 'var(--radius-lg)',
            overflow: "hidden",
          }}
        >
          {/* Toolbar */}
          <div
            className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar"
            style={{ borderBottom: "var(--bw) solid var(--b1)" }}
          >
            <div className="flex items-center gap-4">
              <h2
                className="c-heading"
              >
                Connections
              </h2>

              {/* Mode filter pills */}
              <div className="flex" style={{ gap: "var(--sp-1h)" }}>
                {modeFilterOptions.map((m) => (
                  <FilterPill
                    key={m}
                    label={m === "all" ? "All" : m}
                    isActive={modeFilter === m}
                    activeColor={m === "all" ? "text-t2" : modeTextClass[m]}
                    activeBorder={
                      modeFilter === m
                        ? `var(--bw) solid ${m === "passive" ? "var(--color-m-pas)" : m === "chat" ? "var(--color-m-cht)" : m === "agent" ? "var(--color-m-agt)" : "var(--b4)"}`
                        : undefined
                    }
                    onClick={() => setModeFilter(m)}
                    style={{ padding: "5px var(--sp-3)", gap: "var(--sp-1h)" }}
                    suffix={
                      <span
                        className="text-t5"
                        style={{ fontSize: "var(--font-size-xs)", opacity: 0.7 }}
                      >
                        {modeCounts[m]}
                      </span>
                    }
                  />
                ))}
              </div>
            </div>

            {/* Search — fills remaining toolbar width */}
            <div className="relative flex-1" style={{ marginLeft: "var(--sp-4)" }}>
              <Search
                size={13}
                strokeWidth={1.75}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-t5 pointer-events-none"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search lines..."
                className="w-full bg-d1 text-t2 font-mono outline-none
                           placeholder:text-t5 focus:border-m-cht/40"
                style={{
                  fontSize: "var(--font-size-label)",
                  padding: "var(--sp-1h) var(--sp-3) var(--sp-1h) 28px",
                  border: "var(--bw) solid var(--b2)",
                  borderRadius: "var(--radius-sm)",
                  transition: "border-color 0.2s var(--ease)",
                }}
              />
            </div>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-y-auto scrollbar-hide">
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr
                  className="sticky top-0 bg-d3 z-10"
                  style={{ borderBottom: "var(--bw) solid var(--b2)" }}
                >
                  {[
                    { label: "", w: "36px" },
                    { label: "Line", w: undefined },
                    { label: "Mode", w: "100px" },
                    { label: "Pipeline", w: undefined },
                    { label: "Unread", w: "72px" },
                    { label: "Active", w: "80px" },
                  ].map((h) => (
                    <th
                      key={h.label || "status"}
                      className="text-left c-col-header c-cell"
                      style={{
                        width: h.w,
                      }}
                    >
                      {h.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((line) => {
                  const isError = line.status === "unreachable";
                  const isDegraded = line.status === "degraded";
                  return (
                    <tr
                      key={line.name}
                      onClick={() => navigate(`/lines/${line.name}`)}
                      className="cursor-pointer c-row-hover"
                      style={{
                        borderBottom: "var(--bw) solid var(--b1)",
                        ...(isError
                          ? { backgroundColor: "var(--s-crit-wash)" }
                          : isDegraded
                          ? { backgroundColor: "var(--s-warn-wash)" }
                          : {}),
                      }}
                    >
                      {/* Status */}
                      <td className="c-cell">
                        <StatusDot status={line.status} size="md" />
                      </td>

                      {/* Line name + phone */}
                      <td className="c-cell">
                        <div className="flex flex-col">
                          <span
                            className="font-sans font-medium text-t1"
                            style={{ fontSize: 'var(--font-size-body)' }}
                          >
                            {displayInstanceName(line.name)}
                          </span>
                          <span
                            className="c-label"
                          >
                            {formatPhone(line.phone)}
                          </span>
                        </div>
                      </td>

                      {/* Mode */}
                      <td className="c-cell">
                        <ModeBadge mode={line.mode} />
                      </td>

                      {/* Pipeline */}
                      <td className="c-cell">
                        <span
                          className={`c-data ${pipelineColor(line)}`}
                        >
                          {pipelineText(line)}
                        </span>
                      </td>

                      {/* Unread */}
                      <td className="c-cell">
                        {(line.unread ?? 0) > 0 ? (
                          <span
                            className="c-data text-s-warn font-medium"
                          >
                            {line.unread}
                          </span>
                        ) : (
                          <span className="c-data text-t5">
                            —
                          </span>
                        )}
                      </td>

                      {/* Last Active */}
                      <td className="c-cell">
                        <span
                          className={`c-data ${isError ? "text-s-crit" : "text-t4"}`}
                        >
                          {line.lastActive ? formatRelative(line.lastActive) : "—"}
                        </span>
                      </td>
                    </tr>
                  );
                })}

                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center text-t5 font-mono py-12"
                      style={{ fontSize: 'var(--font-size-data)' }}
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
          className="flex flex-col min-h-0"
          style={{
            flex: 1,
            minWidth: "var(--feed-min-w)",
            background: "var(--color-d1)",
            border: "var(--bw) solid var(--b1)",
            borderRadius: 'var(--radius-lg)',
            overflow: "hidden",
          }}
        >
          <ActivityFeed events={feed} />
        </div>
      </motion.div>
    </div>
  );
};

export default SoupKitchen;
