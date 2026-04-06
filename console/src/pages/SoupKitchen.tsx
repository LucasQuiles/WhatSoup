import { type FC, useState, useMemo, useCallback, lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Plus, ChevronUp, ChevronDown } from "lucide-react";
const AddLineWizard = lazy(() => import("../components/AddLineWizard"));
import { motion } from "framer-motion";
import { useLines, useFeed } from "../hooks/use-fleet";
import { useFleetMetrics } from "../hooks/use-metrics";
import { computeKpis } from "../lib/compute-kpis";
import { deriveFleetMessageSparklines } from "../lib/metrics-sparklines";
import type { Mode } from "../types";
import KpiCard from "../components/KpiCard";
import AlertBanner from "../components/AlertBanner";
import ActivityFeed from "../components/ActivityFeed";
import ModeBadge from "../components/ModeBadge";
import FilterPill from "../components/FilterPill";
import { FleetMetricsChart } from "../components/FleetMetricsChart";
import LineTags from "../components/LineTags";
import { formatRelative } from "../lib/format-time";
import { formatPhone, displayInstanceName, formatCompact } from "../lib/text-utils";


const ease = [0.22, 1, 0.36, 1] as const;

type KpiFilter = "connected" | "attention" | "unread" | "agent" | "messages" | null;
type SortKey = "mode" | "name" | "chats" | "groups" | "unread" | "sent" | "recv" | "tokens" | "sessions" | "active" | null;
type SortDir = "asc" | "desc";

const COLUMNS: { label: string; w: string | undefined; center: boolean; sortKey: SortKey }[] = [
  { label: "Mode", w: "90px", center: false, sortKey: "mode" },
  { label: "Line", w: undefined, center: false, sortKey: "name" },
  { label: "Chats", w: "60px", center: true, sortKey: "chats" },
  { label: "Groups", w: "64px", center: true, sortKey: "groups" },
  { label: "Unread", w: "64px", center: true, sortKey: "unread" },
  { label: "Sent", w: "68px", center: true, sortKey: "sent" },
  { label: "Recv", w: "68px", center: true, sortKey: "recv" },
  { label: "Tokens", w: "80px", center: true, sortKey: "tokens" },
  { label: "Sessions", w: "72px", center: true, sortKey: "sessions" },
  { label: "Tags", w: undefined, center: false, sortKey: null },
  { label: "Active", w: "80px", center: true, sortKey: "active" },
];

const modeFilterOptions: (Mode | "all")[] = ["all", "passive", "chat", "agent"];

const modeTextClass: Record<Mode, string> = {
  passive: "text-m-pas",
  chat: "text-m-cht",
  agent: "text-m-agt",
};


const SoupKitchen: FC = () => {
  const { data: lines = [] } = useLines();
  const { data: feed = [] } = useFeed();
  const navigate = useNavigate();

  const [activeKpi, setActiveKpi] = useState<KpiFilter>(null);
  const [modeFilter, setModeFilter] = useState<Mode | "all">("all");
  const [search, setSearch] = useState("");
  const [showAddWizard, setShowAddWizard] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = useCallback((key: SortKey) => {
    if (!key) return;
    setSortKey(prev => {
      if (prev === key) {
        setSortDir(d => d === "asc" ? "desc" : "asc");
        return key;
      }
      setSortDir("desc");
      return key;
    });
  }, []);

  const kpis = useMemo(() => computeKpis(lines), [lines]);
  const { data: fleetMetrics } = useFleetMetrics('24h');
  const messageSparklines = useMemo(
    () => deriveFleetMessageSparklines(fleetMetrics?.messageVolume),
    [fleetMetrics?.messageVolume],
  );

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

    // Sort
    if (sortKey) {
      const dir = sortDir === "asc" ? 1 : -1;
      result = [...result].sort((a, b) => {
        let av: number | string = 0;
        let bv: number | string = 0;
        switch (sortKey) {
          case "mode": av = a.mode; bv = b.mode; break;
          case "name": av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
          case "chats": av = a.chatCounts?.chats ?? 0; bv = b.chatCounts?.chats ?? 0; break;
          case "groups": av = a.chatCounts?.groups ?? 0; bv = b.chatCounts?.groups ?? 0; break;
          case "unread": av = a.unread ?? 0; bv = b.unread ?? 0; break;
          case "sent": av = a.messageStats?.sent ?? 0; bv = b.messageStats?.sent ?? 0; break;
          case "recv": av = a.messageStats?.received ?? 0; bv = b.messageStats?.received ?? 0; break;
          case "tokens": av = (a.tokenUsage?.input ?? 0) + (a.tokenUsage?.output ?? 0); bv = (b.tokenUsage?.input ?? 0) + (b.tokenUsage?.output ?? 0); break;
          case "sessions": av = a.totalSessions ?? 0; bv = b.totalSessions ?? 0; break;
          case "active": av = a.lastActive ?? ""; bv = b.lastActive ?? ""; break;
        }
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }

    return result;
  }, [lines, activeKpi, modeFilter, search, sortKey, sortDir]);

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
          borderWidth: "var(--bw)", borderStyle: "solid", borderColor: "var(--b1)",
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
          sparkData={messageSparklines?.outbound}
        />
        <KpiCard
          value={kpis.totalReceived.toLocaleString()}
          label="Messages Received"
          color="text-t2"
          onClick={() => toggleKpi("messages")}
          active={activeKpi === "messages"}
          sparkData={messageSparklines?.inbound}
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

      {/* Fleet Metrics Chart */}
      {fleetMetrics?.messageVolume && fleetMetrics.messageVolume.length > 0 && (
        <FleetMetricsChart data={fleetMetrics.messageVolume} />
      )}

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
            borderWidth: "var(--bw)", borderStyle: "solid", borderColor: "var(--b1)",
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
                className="c-heading-lg"
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
                    count={modeCounts[m]}
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
                className="c-input c-input-search"
              />
            </div>

            <button
              className="c-btn c-btn-add flex-shrink-0"
              onClick={() => setShowAddWizard(true)}
              style={{ marginLeft: 'var(--sp-3)' }}
            >
              <Plus size={16} strokeWidth={2} />
              <span className="c-btn-add-label">Add Line</span>
            </button>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-y-auto scrollbar-hide">
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr
                  className="sticky top-0 bg-d3 z-10"
                  style={{ borderBottom: "var(--bw) solid var(--b2)" }}
                >
                  {COLUMNS.map((h) => (
                    <th
                      key={h.label}
                      className={`c-col-header c-cell ${h.center ? "text-center" : "text-left"} ${h.sortKey ? "cursor-pointer select-none" : ""}`}
                      style={{ width: h.w }}
                      onClick={h.sortKey ? () => toggleSort(h.sortKey) : undefined}
                      aria-sort={sortKey === h.sortKey ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
                    >
                      <span className={`inline-flex items-center ${h.center ? "justify-center" : ""}`} style={{ gap: "var(--sp-1)" }}>
                        {h.label}
                        {sortKey === h.sortKey && (
                          sortDir === "asc"
                            ? <ChevronUp size={12} strokeWidth={2} className="text-t3" />
                            : <ChevronDown size={12} strokeWidth={2} className="text-t3" />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((line) => {
                  const isError = line.status === "unreachable";
                  const isDegraded = line.status === "degraded";
                  const sent = line.messageStats?.sent ?? 0;
                  const recv = line.messageStats?.received ?? 0;
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
                      {/* Mode */}
                      <td className="c-cell">
                        <ModeBadge mode={line.mode} />
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
                          <span className="c-label">
                            {formatPhone(line.phone)}
                          </span>
                        </div>
                      </td>

                      {/* Chats */}
                      <td className="c-cell text-center">
                        <span className="c-data text-t2">{line.chatCounts?.chats ?? 0}</span>
                      </td>

                      {/* Groups */}
                      <td className="c-cell text-center">
                        <span className="c-data text-t4">{line.chatCounts?.groups ?? 0}</span>
                      </td>

                      {/* Unread */}
                      <td className="c-cell text-center">
                        {(line.unread ?? 0) > 0 ? (
                          <span className="c-data text-s-warn font-medium">
                            {line.unread}
                          </span>
                        ) : (
                          <span className="c-data text-t5">0</span>
                        )}
                      </td>

                      {/* Sent (today) */}
                      <td className="c-cell text-center">
                        <span className="c-data text-s-ok">↑{sent}</span>
                      </td>

                      {/* Received (today) */}
                      <td className="c-cell text-center">
                        <span className="c-data text-m-cht">↓{recv}</span>
                      </td>

                      {/* Tokens (lifetime) */}
                      <td className="c-cell text-center">
                        {(line.tokenUsage?.input ?? 0) > 0 ? (
                          <span className="c-data text-t2" title={`${(line.tokenUsage?.input ?? 0).toLocaleString()} in / ${(line.tokenUsage?.output ?? 0).toLocaleString()} out`}>
                            {formatCompact((line.tokenUsage?.input ?? 0) + (line.tokenUsage?.output ?? 0))}
                          </span>
                        ) : (
                          <span className="c-data text-t5">—</span>
                        )}
                      </td>

                      {/* Sessions (lifetime, agent lines only) */}
                      <td className="c-cell text-center">
                        {line.mode === 'agent' ? (
                          <span className="c-data text-m-agt font-medium">
                            {line.totalSessions ?? 0}
                          </span>
                        ) : (
                          <span className="c-data text-t5">—</span>
                        )}
                      </td>

                      {/* Tags */}
                      <td className="c-cell">
                        <LineTags line={line} />
                      </td>

                      {/* Last Active */}
                      <td className="c-cell text-center">
                        <span
                          className={`c-data ${isError ? "text-s-crit" : "text-t4"}`}
                          style={{ whiteSpace: 'nowrap' }}
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
                      colSpan={11}
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
            borderWidth: "var(--bw)", borderStyle: "solid", borderColor: "var(--b1)",
            borderRadius: 'var(--radius-lg)',
            overflow: "hidden",
          }}
        >
          <ActivityFeed events={feed} />
        </div>
      </motion.div>

      <Suspense fallback={null}>
        {showAddWizard && <AddLineWizard onClose={() => setShowAddWizard(false)} />}
      </Suspense>
    </div>
  );
};

export default SoupKitchen;
