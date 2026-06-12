import { type FC, useState, useMemo, useCallback, lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Plus, ChevronUp, ChevronDown } from "lucide-react";
const AddLineWizard = lazy(() => import("../components/AddLineWizard"));
import { motion } from "framer-motion";
import { useLines, useFeed } from "../hooks/use-fleet";
import { useFleetMetrics } from "../hooks/use-metrics";
import { computeKpis } from "../lib/compute-kpis";
import { deriveFleetMessageSparklines, deriveFleetSessionSparklines } from "../lib/metrics-sparklines";
import type { FeedEvent, LineInstance, Mode, MetricsRange } from "../types";
import type { ChartKey } from "../components/ChartPanel";
import KpiCard from "../components/KpiCard";
import AlertBanner from "../components/AlertBanner";
import ActivityFeed from "../components/ActivityFeed";
import ModeBadge from "../components/ModeBadge";
import FilterPill from "../components/FilterPill";
import { ChartPanel } from "../components/ChartPanel";
import { FleetMetricsChart } from "../components/FleetMetricsChart";
import { FleetTokenChart } from "../components/FleetTokenChart";
import { FleetSessionChart } from "../components/FleetSessionChart";
import LineTags from "../components/LineTags";
import { formatRelative } from "../lib/format-time";
import { formatPhone, displayInstanceName, formatCompact } from "../lib/text-utils";
import { getProvider, getProviderColor } from "../lib/providers";
import { statusAlertMessage, statusNeedsAttention, statusSeverity, statusWashClass } from "../lib/status-severity";


const ease = [0.22, 1, 0.36, 1] as const;

type KpiFilter = "connected" | "attention" | "unread" | "agent" | "sent" | "received" | "media" | null;
type SortKey = "mode" | "name" | "chats" | "groups" | "unread" | "sent" | "recv" | "tokens" | "sessions" | "provider" | "active" | null;
type SortDir = "asc" | "desc";

const COLUMNS: { label: string; widthClass?: string; center: boolean; sortKey: SortKey }[] = [
  { label: "Mode", widthClass: "w-[var(--sk-col-mode)]", center: false, sortKey: "mode" },
  { label: "Line", center: false, sortKey: "name" },
  { label: "Chats", widthClass: "w-[var(--sk-col-chats)]", center: true, sortKey: "chats" },
  { label: "Groups", widthClass: "w-[var(--sk-col-count)]", center: true, sortKey: "groups" },
  { label: "Unread", widthClass: "w-[var(--sk-col-count)]", center: true, sortKey: "unread" },
  { label: "Sent", widthClass: "w-[var(--sk-col-msg)]", center: true, sortKey: "sent" },
  { label: "Recv", widthClass: "w-[var(--sk-col-msg)]", center: true, sortKey: "recv" },
  { label: "Tokens", widthClass: "w-[var(--sk-col-tokens)]", center: true, sortKey: "tokens" },
  { label: "Sessions", widthClass: "w-[var(--sk-col-sessions)]", center: true, sortKey: "sessions" },
  { label: "Provider", widthClass: "w-[var(--sk-col-provider)]", center: false, sortKey: "provider" },
  { label: "Tags", center: false, sortKey: null },
  { label: "Active", widthClass: "w-[var(--sk-col-tokens)]", center: true, sortKey: "active" },
];

const modeFilterOptions: (Mode | "all")[] = ["all", "passive", "chat", "agent"];

const modeTextClass: Record<Mode, string> = {
  passive: "text-m-pas",
  chat: "text-m-cht",
  agent: "text-m-agt",
};

const RANGE_OPTIONS: MetricsRange[] = ['24h', '7d', '30d'];
const EMPTY_LINES: LineInstance[] = [];
const EMPTY_FEED: FeedEvent[] = [];

function chartColStyle(key: ChartKey, expanded: ChartKey | null) {
  if (expanded !== null && expanded !== key) {
    return { flex: 0, opacity: 0, minWidth: 0, width: 0, overflow: 'hidden' as const };
  }
  return { flex: 1, opacity: 1 };
}

const SoupKitchen: FC = () => {
  const { data: lineData, isError: linesError, error: linesQueryError } = useLines();
  const { data: feedData, isError: feedError, error: feedQueryError } = useFeed();
  const navigate = useNavigate();

  const lines = lineData ?? EMPTY_LINES;
  const feed = feedData ?? EMPTY_FEED;
  const fleetLoadError = linesError || feedError;
  const fleetLoadErrorMessage =
    linesQueryError?.message ?? feedQueryError?.message ?? "Unable to load fleet data";

  const [activeKpi, setActiveKpi] = useState<KpiFilter>(null);
  const [expandedChart, setExpandedChart] = useState<ChartKey | null>(null);
  const [chartRange, setChartRange] = useState<MetricsRange>("24h");
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
  const { data: fleetMetrics, isLoading: metricsLoading, isError: metricsError, refetch: metricsRefetch } = useFleetMetrics(chartRange);
  const messageSparklines = useMemo(
    () => deriveFleetMessageSparklines(fleetMetrics?.messageVolume),
    [fleetMetrics?.messageVolume],
  );
  const sessionSparklines = useMemo(
    () => deriveFleetSessionSparklines(fleetMetrics?.sessionActivity),
    [fleetMetrics?.sessionActivity],
  );

  function toggleKpi(kpiKey: KpiFilter, chartKey: ChartKey | null = null) {
    const next = activeKpi === kpiKey ? null : kpiKey;
    setActiveKpi(next);
    if (chartKey) {
      setExpandedChart(next === null ? null : chartKey);
    }
  }

  // Derive alerts from lines
  const alerts = useMemo(
    () =>
      lines
        .filter((l) => statusNeedsAttention(l.status))
        .map((l) => ({
          line: l.name,
          message: statusAlertMessage(l.status, l.lastSessionStatus),
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
        (l) => statusNeedsAttention(l.status) || l.error
      );
    else if (activeKpi === "unread")
      result = result.filter((l) => (l.unread ?? 0) > 0);
    else if (activeKpi === "agent")
      result = result.filter((l) => l.mode === "agent");
    else if (activeKpi === "sent")
      result = result.filter((l) => (l.messageStats?.sent ?? 0) > 0);
    else if (activeKpi === "received")
      result = result.filter((l) => (l.messageStats?.received ?? 0) > 0);
    else if (activeKpi === "media")
      result = result.filter((l) => {
        const s = l.messageStats;
        return s ? (s.images + s.audio + s.documents) > 0 : false;
      });

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
          case "provider": av = a.provider ?? 'claude-cli'; bv = b.provider ?? 'claude-cli'; break;
          case "active": av = a.lastActive ?? ""; bv = b.lastActive ?? ""; break;
        }
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }

    return result;
  }, [lines, activeKpi, modeFilter, search, sortKey, sortDir]);

  const meta = fleetMetrics?.meta;
  const instancesFailed = meta?.instancesFailed ?? 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden p-[var(--sp-4)] gap-[var(--sp-3)]">
      {/* KPI Strip */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="c-card flex-shrink-0 grid grid-cols-7 gap-[var(--sp-2)] p-[var(--sp-2)]"
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
          onClick={() => toggleKpi("sent", "messages")}
          active={activeKpi === "sent"}
          sparkData={messageSparklines?.outbound}
        />
        <KpiCard
          value={kpis.totalReceived.toLocaleString()}
          label="Messages Received"
          color="text-t2"
          onClick={() => toggleKpi("received", "messages")}
          active={activeKpi === "received"}
          sparkData={messageSparklines?.inbound}
        />
        <KpiCard
          value={kpis.agentSessions}
          label="Agent Sessions"
          color="text-m-agt"
          onClick={() => toggleKpi("agent", "sessions")}
          active={activeKpi === "agent"}
          sparkData={sessionSparklines?.active}
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
          onClick={() => toggleKpi("media", "messages")}
          active={activeKpi === "media"}
          sparkData={messageSparklines?.media}
        />
      </motion.div>

      {/* Charts Section */}
      <div className="c-card flex-shrink-0 p-[var(--sp-2)] flex flex-col gap-[var(--sp-2)]">
        {/* Header — title left, range picker right */}
        <div className="flex items-center justify-between">
          <h2 className="c-heading-lg">Metrics</h2>
          <div className="flex items-center gap-[var(--sp-2)]">
            {RANGE_OPTIONS.map((r) => (
              <FilterPill
                key={r}
                label={r}
                isActive={chartRange === r}
                onClick={() => setChartRange(r)}
              />
            ))}
          </div>
        </div>

        {/* Chart Row — 3-up with expansion */}
        <div className="flex" style={{ gap: expandedChart ? 0 : 'var(--sp-2)' }}>
          <div
            className="c-chart-expand-col"
            style={chartColStyle('messages', expandedChart)}
          >
            <ChartPanel
              title={`Message Volume (${chartRange})`}
              isLoading={metricsLoading}
              isError={metricsError}
              hasData={meta?.hasMessageData ?? false}
              instancesFailed={instancesFailed}
              expanded={expandedChart === 'messages'}
              onRetry={() => metricsRefetch()}
            >
              {fleetMetrics?.messageVolume && (
                <FleetMetricsChart data={fleetMetrics.messageVolume} range={chartRange} />
              )}
            </ChartPanel>
          </div>

          <div
            className="c-chart-expand-col"
            style={chartColStyle('tokens', expandedChart)}
          >
            <ChartPanel
              title={`Token Usage (${chartRange})`}
              isLoading={metricsLoading}
              isError={metricsError}
              hasData={meta?.hasTokenData ?? false}
              instancesFailed={instancesFailed}
              expanded={expandedChart === 'tokens'}
              onRetry={() => metricsRefetch()}
            >
              {fleetMetrics?.tokenUsage && (
                <FleetTokenChart
                  data={fleetMetrics.tokenUsage}
                  byProvider={fleetMetrics.tokenUsageByProvider}
                  providers={fleetMetrics.meta?.providers}
                  range={chartRange}
                />
              )}
            </ChartPanel>
          </div>

          <div
            className="c-chart-expand-col"
            style={chartColStyle('sessions', expandedChart)}
          >
            <ChartPanel
              title={`Session Activity (${chartRange})`}
              isLoading={metricsLoading}
              isError={metricsError}
              hasData={meta?.hasSessionData ?? false}
              instancesFailed={instancesFailed}
              expanded={expandedChart === 'sessions'}
              onRetry={() => metricsRefetch()}
            >
              {fleetMetrics?.sessionActivity && (
                <FleetSessionChart
                  data={fleetMetrics.sessionActivity}
                  byProvider={fleetMetrics.sessionActivityByProvider}
                  providers={fleetMetrics.meta?.providers}
                  range={chartRange}
                />
              )}
            </ChartPanel>
          </div>
        </div>
      </div>

      {/* Alert Banner */}
      <AlertBanner alerts={alerts} />

      {/* Main area — instances table + activity feed */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.1, ease }}
        className="flex flex-1 min-h-0 gap-[var(--sp-3)]"
      >
        {/* Connection Table */}
        <div className="c-card flex flex-col min-h-0 overflow-hidden basis-0 grow-[3]">
          {/* Toolbar */}
          <div className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar c-border-b">
            <div className="flex items-center gap-4">
              <h2 className="c-heading-lg">Instances</h2>

              {/* Mode filter pills */}
              <div className="flex gap-[var(--sp-1h)]">
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

            {/* Search */}
            <div className="relative flex-1 ml-[var(--sp-4)]">
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
                aria-label="Search lines"
                className="c-input c-input-search"
              />
            </div>

            <button
              type="button"
              className="c-btn c-btn-add flex-shrink-0 ml-[var(--sp-3)]"
              onClick={() => setShowAddWizard(true)}
            >
              <Plus size={16} strokeWidth={1.75} />
              <span className="c-btn-add-label">Add Line</span>
            </button>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-y-auto scrollbar-hide">
            <table className="w-full border-collapse">
              <thead>
                <tr className="sticky top-0 bg-d3 z-10 c-border-b-b2">
                  {COLUMNS.map((h) => (
                    <th
                      key={h.label}
                      className={`c-col-header c-cell ${h.widthClass ?? ""} ${h.center ? "text-center" : "text-left"} ${h.sortKey ? "cursor-pointer select-none" : ""}`}
                      onClick={h.sortKey ? () => toggleSort(h.sortKey) : undefined}
                      aria-sort={sortKey === h.sortKey ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
                    >
                      <span className={`inline-flex items-center gap-[var(--sp-1)] ${h.center ? "justify-center" : ""}`}>
                        {h.label}
                        {sortKey === h.sortKey && (
                          sortDir === "asc"
                            ? <ChevronUp size={12} strokeWidth={1.75} className="text-t3" />
                            : <ChevronDown size={12} strokeWidth={1.75} className="text-t3" />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((line) => {
                  const severity = statusSeverity(line.status);
                  const isError = severity === "crit";
                  const sent = line.messageStats?.sent ?? 0;
                  const recv = line.messageStats?.received ?? 0;
                  return (
                    <tr
                      key={line.name}
                      onClick={() => navigate(`/lines/${line.name}`)}
                      className={`cursor-pointer c-row-hover c-border-b ${statusWashClass(line.status)}`}
                    >
                      <td className="c-cell"><ModeBadge mode={line.mode} /></td>
                      <td className="c-cell">
                        <div className="flex flex-col">
                          <span className="font-sans font-medium text-t1 text-body">{displayInstanceName(line.name)}</span>
                          <span className="c-label">{formatPhone(line.phone)}</span>
                        </div>
                      </td>
                      <td className="c-cell text-center"><span className="c-data text-t2">{line.chatCounts?.chats ?? 0}</span></td>
                      <td className="c-cell text-center"><span className="c-data text-t4">{line.chatCounts?.groups ?? 0}</span></td>
                      <td className="c-cell text-center">
                        {(line.unread ?? 0) > 0
                          ? <span className="c-data text-s-warn font-medium">{line.unread}</span>
                          : <span className="c-data text-t5">0</span>}
                      </td>
                      <td className="c-cell text-center"><span className="c-data text-s-ok">{String.fromCharCode(0x2191)}{sent}</span></td>
                      <td className="c-cell text-center"><span className="c-data text-m-cht">{String.fromCharCode(0x2193)}{recv}</span></td>
                      <td className="c-cell text-center">
                        {(line.tokenUsage?.input ?? 0) > 0
                          ? <span className="c-data text-t2" title={`${(line.tokenUsage?.input ?? 0).toLocaleString()} in / ${(line.tokenUsage?.output ?? 0).toLocaleString()} out`}>{formatCompact((line.tokenUsage?.input ?? 0) + (line.tokenUsage?.output ?? 0))}</span>
                          : <span className="c-data text-t5">{String.fromCharCode(0x2014)}</span>}
                      </td>
                      <td className="c-cell text-center">
                        {line.mode === 'agent'
                          ? <span className="c-data text-m-agt font-medium">{line.totalSessions ?? 0}</span>
                          : <span className="c-data text-t5">{String.fromCharCode(0x2014)}</span>}
                      </td>
                      {/* Provider */}
                      <td className="c-cell">
                        <span className="c-data" style={{ color: getProviderColor(line.provider ?? 'claude-cli').stroke }}>
                          {getProvider(line.provider ?? 'claude-cli')?.shortName ?? 'Claude'}
                        </span>
                      </td>
                      <td className="c-cell"><LineTags line={line} /></td>
                      <td className="c-cell text-center">
                        <span className={`c-data whitespace-nowrap ${isError ? "text-s-crit" : "text-t4"}`}>
                          {line.lastActive ? formatRelative(line.lastActive) : String.fromCharCode(0x2014)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {fleetLoadError && (
                  <tr>
                    <td colSpan={12} className="text-center text-s-crit font-sans py-12 text-data">
                      Unable to load fleet data: {fleetLoadErrorMessage}
                    </td>
                  </tr>
                )}
                {!fleetLoadError && filtered.length === 0 && (
                  <tr>
                    <td colSpan={12} className="text-center text-t5 font-sans py-12 text-data">
                      No instances match the current filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Activity Feed */}
        <div className="c-card flex flex-col min-h-0 overflow-hidden basis-0 flex-1 min-w-[var(--feed-min-w)]">
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
