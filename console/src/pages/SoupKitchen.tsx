import {
  type FC,
  type RefObject,
  useState,
  useMemo,
  useCallback,
  useId,
  useRef,
  lazy,
  Suspense,
} from "react";
import { useNavigate } from "react-router-dom";
import { Plus, RotateCw } from "lucide-react";
const AddLineWizard = lazy(() => import("../components/AddLineWizard"));
import { motion } from "framer-motion";
import { useLines, useFeed, useLogs } from "../hooks/use-fleet";
import { useFleetMetrics } from "../hooks/use-metrics";
import { computeKpis } from "../lib/compute-kpis";
import {
  deriveFleetMessageSparklines,
  deriveFleetSessionSparklines,
} from "../lib/metrics-sparklines";
import type { FeedEvent, LineInstance, Mode, MetricsRange } from "../types";
import type { ChartKey } from "../components/ChartPanel";
import KpiCard from "../components/KpiCard";
import AlertBanner from "../components/AlertBanner";
import ActivityFeed from "../components/ActivityFeed";
import FilterPill from "../components/FilterPill";
import { ChartPanel } from "../components/ChartPanel";
import { FleetMetricsChart } from "../components/FleetMetricsChart";
import { FleetTokenChart } from "../components/FleetTokenChart";
import { FleetSessionChart } from "../components/FleetSessionChart";
import LineTags from "../components/LineTags";
import { formatRelative } from "../lib/format-time";
import {
  formatPhone,
  displayInstanceName,
  formatCompact,
  formatCount,
} from "../lib/text-utils";
import { getProvider, getProviderColor } from "../lib/providers";
import {
  Table,
  TableHeader,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  TableEmpty,
  TableError,
  EM_DASH,
  Toolbar,
  ToolbarFilters,
  ToolbarSearch,
  ToolbarSpring,
  ToolbarTimeRange,
  StatusCell,
  ModeBadge,
  Button,
  DrawerLayout,
  Drawer,
  DrawerHeader,
  DrawerBody,
  LogStream,
  type SortState,
  type RowSeverity,
  type TimeRangeOption,
} from "../components/primitives";
import { statusNeedsAttention, statusAlertMessage, statusSeverity } from "../lib/status-severity";

const ease = [0.22, 1, 0.36, 1] as const;

type KpiFilter =
  | "connected"
  | "attention"
  | "unread"
  | "agent"
  | "sent"
  | "received"
  | "media"
  | null;

type SortKey =
  | "mode"
  | "name"
  | "chats"
  | "groups"
  | "unread"
  | "sent"
  | "recv"
  | "tokens"
  | "sessions"
  | "provider"
  | "active"
  | null;

/** Column count for colSpan states. */
const COL_COUNT = 12;

const modeFilterOptions: (Mode | "all")[] = ["all", "passive", "chat", "agent"];

const modeTextClass: Record<Mode, string> = {
  passive: "text-m-pas",
  chat: "text-m-cht",
  agent: "text-m-agt",
};

const RANGE_OPTIONS: TimeRangeOption[] = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
];
const EMPTY_LINES: LineInstance[] = [];
const EMPTY_FEED: FeedEvent[] = [];

function chartColStyle(key: ChartKey, expanded: ChartKey | null) {
  if (expanded !== null && expanded !== key) {
    return {
      flex: 0,
      opacity: 0,
      minWidth: 0,
      width: 0,
      overflow: "hidden" as const,
    };
  }
  return { flex: 1, opacity: 1 };
}

// ---------------------------------------------------------------------------
// FleetDrawer — line inspector panel
// ---------------------------------------------------------------------------

interface FleetDrawerProps {
  selectedName: string | null;
  lines: LineInstance[];
  onClose: () => void;
  onOpenLine: (name: string) => void;
  /** Current originating row — Drawer focus-restore target across retargets. */
  restoreFocus: RefObject<HTMLElement | null>;
}

/** Maximum log entries shown in the drawer scoped log (last-N). */
const DRAWER_LOG_MAX = 50;

const FleetDrawer: FC<FleetDrawerProps> = ({
  selectedName,
  lines,
  onClose,
  onOpenLine,
  restoreFocus,
}) => {
  const titleId = useId();
  const logsResult = useLogs(selectedName ?? "");
  const isOpen = selectedName !== null;

  const line = selectedName
    ? lines.find((l) => l.name === selectedName) ?? null
    : null;

  // Missing-entity: selectedName is set but the line is not in the dataset (§6.1).
  const isMissing = isOpen && selectedName !== null && line === null;

  return (
    <Drawer
      open={isOpen}
      onClose={onClose}
      aria-labelledby={titleId}
      restoreFocus={restoreFocus}
    >
      {isMissing ? (
        <>
          <DrawerHeader
            title="Line not found"
            titleId={titleId}
            onClose={onClose}
          />
          <DrawerBody>
            <div className="soup-drawer-kv">
              <p className="soup-drawer-kv__empty">
                This line is no longer available.
              </p>
            </div>
            <div className="soup-drawer-actions">
              <Button variant="neutral" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </DrawerBody>
        </>
      ) : line ? (
        <>
          <DrawerHeader
            statusShape={<StatusCell status={line.status} />}
            title={displayInstanceName(line.name)}
            titleId={titleId}
            modeBadge={<ModeBadge mode={line.mode} />}
            onClose={onClose}
          />
          <DrawerBody>
            {/* KV block — identity + activity fields (C-1: fields the table showed + drop-policy extras) */}
            <dl className="soup-drawer-kv">
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Phone</dt>
                <dd className="soup-drawer-kv__val">
                  {formatPhone(line.phone)}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Provider</dt>
                <dd
                  className="soup-drawer-kv__val"
                  style={{
                    color: getProviderColor(line.provider ?? "claude-cli")
                      .stroke,
                  }}
                >
                  {getProvider(line.provider ?? "claude-cli")?.shortName ??
                    "Claude"}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Uptime</dt>
                <dd className="soup-drawer-kv__val">
                  {line.uptime ?? <EM_DASH />}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Chats</dt>
                <dd className="soup-drawer-kv__val">
                  {line.chatCounts?.chats ?? <EM_DASH />}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Groups</dt>
                <dd className="soup-drawer-kv__val">
                  {line.chatCounts?.groups ?? <EM_DASH />}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Unread</dt>
                <dd className="soup-drawer-kv__val">
                  {line.unread ?? <EM_DASH />}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Sent</dt>
                <dd className="soup-drawer-kv__val">
                  {line.messageStats?.sent ?? <EM_DASH />}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Received</dt>
                <dd className="soup-drawer-kv__val">
                  {line.messageStats?.received ?? <EM_DASH />}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Tokens</dt>
                <dd className="soup-drawer-kv__val">
                  {(line.tokenUsage?.input ?? 0) > 0 ? (
                    formatCompact(
                      (line.tokenUsage?.input ?? 0) +
                        (line.tokenUsage?.output ?? 0)
                    )
                  ) : (
                    <EM_DASH />
                  )}
                </dd>
              </div>
              {line.mode === "agent" && (
                <div className="soup-drawer-kv__row">
                  <dt className="soup-drawer-kv__key">Sessions</dt>
                  <dd className="soup-drawer-kv__val">
                    {line.totalSessions ?? <EM_DASH />}
                  </dd>
                </div>
              )}
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Last active</dt>
                <dd className="soup-drawer-kv__val">
                  {line.lastActive ? (
                    formatRelative(line.lastActive)
                  ) : (
                    <EM_DASH />
                  )}
                </dd>
              </div>
            </dl>

            {/* Remedy — explicit "Open line" navigates to full detail (drill-in law) */}
            <div className="soup-drawer-actions">
              <Button
                variant="neutral"
                size="sm"
                onClick={() => onOpenLine(line.name)}
              >
                Open line
              </Button>
            </div>

            {/* Scoped log — last DRAWER_LOG_MAX entries for this line */}
            <div className="soup-drawer-log">
              <LogStream
                entries={logsResult.data ?? []}
                density="compressed"
                maxEntries={DRAWER_LOG_MAX}
                error={
                  logsResult.isError
                    ? "Could not load logs for this line."
                    : undefined
                }
                onRetry={() => logsResult.refetch()}
              />
            </div>
          </DrawerBody>
        </>
      ) : null}
    </Drawer>
  );
};

// ---------------------------------------------------------------------------
// SoupKitchen page
// ---------------------------------------------------------------------------

const SoupKitchen: FC = () => {
  const {
    data: lineData,
    isError: linesError,
    error: linesQueryError,
    refetch: refetchLines,
  } = useLines();
  const {
    data: feedData,
    isError: feedError,
    error: feedQueryError,
    refetch: refetchFeed,
  } = useFeed();
  const navigate = useNavigate();

  const lines = lineData ?? EMPTY_LINES;
  const feed = feedData ?? EMPTY_FEED;
  const fleetLoadError = linesError || feedError;
  const feedLoadErrorMessage = feedQueryError?.message ?? "Unable to load activity feed";
  const fleetLoadErrorMessage =
    linesQueryError?.message ??
    feedQueryError?.message ??
    "Unable to load fleet data";

  const [activeKpi, setActiveKpi] = useState<KpiFilter>(null);
  const [expandedChart, setExpandedChart] = useState<ChartKey | null>(null);
  const [chartRange, setChartRange] = useState<MetricsRange>("24h");
  const [modeFilter, setModeFilter] = useState<Mode | "all">("all");
  const [search, setSearch] = useState("");
  const [showAddWizard, setShowAddWizard] = useState(false);
  // C-B3W4-3: latched mount — keep wizard mounted after first open
  // so useDismissable can restore focus and exit motion can complete.
  const [wizardEverOpened, setWizardEverOpened] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Drawer: name of the inspected line, null = drawer closed.
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // Element of the currently-selected row. Updated by the current row's ref
  // callback (never nulled — restoreFocus checks document.contains at close).
  const selectedRowRef = useRef<HTMLElement | null>(null);

  // handleSort adapts the primitive's three-way cycle (none/asc/desc) onto
  // our two-way sortDir; 'none' clears the sort key.
  const handleSort = useCallback(
    (next: SortState) => {
      if (next.dir === "none") {
        setSortKey(null);
        setSortDir("desc");
      } else {
        setSortKey(next.key as SortKey);
        setSortDir(next.dir === "asc" ? "asc" : "desc");
      }
    },
    []
  );

  // Derive the SortState object consumed by TableHeaderCell.
  const sortState: SortState = useMemo(
    () => ({
      key: sortKey ?? "",
      dir: sortKey ? sortDir : "none",
    }),
    [sortKey, sortDir]
  );

  const kpis = useMemo(() => computeKpis(lines), [lines]);
  const {
    data: fleetMetrics,
    isLoading: metricsLoading,
    isError: metricsError,
    refetch: metricsRefetch,
  } = useFleetMetrics(chartRange);
  const messageSparklines = useMemo(
    () => deriveFleetMessageSparklines(fleetMetrics?.messageVolume),
    [fleetMetrics?.messageVolume]
  );
  const sessionSparklines = useMemo(
    () => deriveFleetSessionSparklines(fleetMetrics?.sessionActivity),
    [fleetMetrics?.sessionActivity]
  );

  function toggleKpi(kpiKey: KpiFilter, chartKey: ChartKey | null = null) {
    const next = activeKpi === kpiKey ? null : kpiKey;
    setActiveKpi(next);
    if (chartKey) {
      setExpandedChart(next === null ? null : chartKey);
    }
  }

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

  const filtered = useMemo(() => {
    let result = lines;

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
        return s ? s.images + s.audio + s.documents > 0 : false;
      });

    if (modeFilter !== "all")
      result = result.filter((l) => l.mode === modeFilter);

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (l) =>
          l.name.toLowerCase().includes(q) ||
          (l.phone ?? "").toLowerCase().includes(q)
      );
    }

    if (sortKey) {
      const dir = sortDir === "asc" ? 1 : -1;
      result = [...result].sort((a, b) => {
        let av: number | string = 0;
        let bv: number | string = 0;
        switch (sortKey) {
          case "mode":
            av = a.mode;
            bv = b.mode;
            break;
          case "name":
            av = a.name.toLowerCase();
            bv = b.name.toLowerCase();
            break;
          case "chats":
            av = a.chatCounts?.chats ?? 0;
            bv = b.chatCounts?.chats ?? 0;
            break;
          case "groups":
            av = a.chatCounts?.groups ?? 0;
            bv = b.chatCounts?.groups ?? 0;
            break;
          case "unread":
            av = a.unread ?? 0;
            bv = b.unread ?? 0;
            break;
          case "sent":
            av = a.messageStats?.sent ?? 0;
            bv = b.messageStats?.sent ?? 0;
            break;
          case "recv":
            av = a.messageStats?.received ?? 0;
            bv = b.messageStats?.received ?? 0;
            break;
          case "tokens":
            av =
              (a.tokenUsage?.input ?? 0) + (a.tokenUsage?.output ?? 0);
            bv =
              (b.tokenUsage?.input ?? 0) + (b.tokenUsage?.output ?? 0);
            break;
          case "sessions":
            av = a.totalSessions ?? 0;
            bv = b.totalSessions ?? 0;
            break;
          case "provider":
            av = a.provider ?? "claude-cli";
            bv = b.provider ?? "claude-cli";
            break;
          case "active":
            av = a.lastActive ?? "";
            bv = b.lastActive ?? "";
            break;
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

  const openDrawer = useCallback((name: string) => {
    setSelectedName(name);
  }, []);

  const closeDrawer = useCallback(() => {
    setSelectedName(null);
  }, []);

  const openLine = useCallback(
    (name: string) => {
      navigate(`/lines/${name}`);
    },
    [navigate]
  );

  const drawerEl = (
    <FleetDrawer
      selectedName={selectedName}
      lines={lines}
      onClose={closeDrawer}
      onOpenLine={openLine}
      restoreFocus={selectedRowRef}
    />
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-x-hidden overflow-y-auto p-[var(--sp-4)] gap-[var(--sp-3)]">
      {/* KPI Strip — flex-wrap: multiple rows at narrow widths, no horizontal overflow (DD-18) */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="c-card flex-shrink-0 flex flex-wrap gap-[var(--sp-2)] p-[var(--sp-2)]"
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
          value={formatCount(kpis.totalSent)}
          label="Messages Sent"
          color="neutral"
          onClick={() => toggleKpi("sent", "messages")}
          active={activeKpi === "sent"}
          sparkData={messageSparklines?.outbound}
        />
        <KpiCard
          value={formatCount(kpis.totalReceived)}
          label="Messages Received"
          color="neutral"
          onClick={() => toggleKpi("received", "messages")}
          active={activeKpi === "received"}
          sparkData={messageSparklines?.inbound}
        />
        <KpiCard
          value={kpis.agentSessions}
          label="Agent Sessions"
          color="neutral"
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
          value={formatCount(kpis.totalMedia)}
          label="Media Processed"
          color="neutral"
          onClick={() => toggleKpi("media", "messages")}
          active={activeKpi === "media"}
          sparkData={messageSparklines?.media}
        />
      </motion.div>

      {/* Charts Section */}
      <div className="c-card flex-shrink-0 p-[var(--sp-2)] flex flex-col gap-[var(--sp-2)]">
        <div className="flex items-center justify-between">
          <h2 className="c-heading-lg">Metrics</h2>
          <ToolbarTimeRange
            label="Chart range"
            options={RANGE_OPTIONS}
            value={chartRange}
            onChange={(v) => setChartRange(v as MetricsRange)}
          />
        </div>

        {/* Chart Row — 3-up with expansion; transitions removed for snap (DD-18) */}
        <div
          className="flex"
          style={{ gap: expandedChart ? 0 : "var(--sp-2)" }}
        >
          <div
            className="c-chart-expand-col"
            style={chartColStyle("messages", expandedChart)}
          >
            <ChartPanel
              title={`Message Volume (${chartRange})`}
              isLoading={metricsLoading}
              isError={metricsError}
              hasData={meta?.hasMessageData ?? false}
              instancesFailed={instancesFailed}
              expanded={expandedChart === "messages"}
              onRetry={() => metricsRefetch()}
            >
              {fleetMetrics?.messageVolume && (
                <FleetMetricsChart
                  data={fleetMetrics.messageVolume}
                  range={chartRange}
                />
              )}
            </ChartPanel>
          </div>

          <div
            className="c-chart-expand-col"
            style={chartColStyle("tokens", expandedChart)}
          >
            <ChartPanel
              title={`Token Usage (${chartRange})`}
              isLoading={metricsLoading}
              isError={metricsError}
              hasData={meta?.hasTokenData ?? false}
              instancesFailed={instancesFailed}
              expanded={expandedChart === "tokens"}
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
            style={chartColStyle("sessions", expandedChart)}
          >
            <ChartPanel
              title={`Session Activity (${chartRange})`}
              isLoading={metricsLoading}
              isError={metricsError}
              hasData={meta?.hasSessionData ?? false}
              instancesFailed={instancesFailed}
              expanded={expandedChart === "sessions"}
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
        className="flex flex-col lg:flex-row flex-1 min-h-[var(--fleet-pane-min-h)] gap-[var(--sp-3)]"
      >
        {/* Connection Table */}
        <div className="c-card flex flex-col overflow-hidden min-h-[var(--fleet-pane-min-h)] lg:basis-0 lg:grow-[3]">
          {/* Instances heading — layout hierarchy: above the toolbar anatomy */}
          <h2 className="c-heading-lg flex-shrink-0 px-[var(--sp-3)] pt-[var(--sp-2)]">
            Instances
          </h2>

          {/* Toolbar — filter group + search + primary action; no time-range (C-2) */}
          <Toolbar
            aria-label="Instance filters"
            className="flex-shrink-0"
          >
            <ToolbarFilters label="Mode filter">
              {modeFilterOptions.map((m) => (
                <FilterPill
                  key={m}
                  label={m === "all" ? "All" : m}
                  isActive={modeFilter === m}
                  activeColor={m === "all" ? "text-t2" : modeTextClass[m]}
                  activeBorder={
                    modeFilter === m
                      ? `var(--bw) solid ${
                          m === "passive"
                            ? "var(--color-m-pas)"
                            : m === "chat"
                              ? "var(--color-m-cht)"
                              : m === "agent"
                                ? "var(--color-m-agt)"
                                : "var(--b4)"
                        }`
                      : undefined
                  }
                  onClick={() => setModeFilter(m)}
                  count={modeCounts[m]}
                />
              ))}
            </ToolbarFilters>

            <ToolbarSpring />

            <ToolbarSearch
              label="Search lines"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search lines..." shortcutTarget
            />

            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={16} strokeWidth={1.75} />}
              className="flex-shrink-0"
              onClick={() => { setShowAddWizard(true); setWizardEverOpened(true); }}
            >
              Add Line
            </Button>
          </Toolbar>

          {/* DrawerLayout — squeeze: table is flex sibling of the drawer at ≥1080px */}
          <DrawerLayout
            className="flex-1 min-h-0 overflow-hidden"
            drawer={drawerEl}
          >
            {/* Table region — governed x-scroll; never page-level overflow */}
            <div className="min-h-0 min-w-0 overflow-y-auto overflow-x-auto scrollbar-hide h-full">
              <Table density="compressed">
                <TableHeader>

                  <tr>
                    {/* Col 0: Status+name — StatusCell (shape law) */}
                    <TableHeaderCell
                      sortKey="name"
                      sort={sortState}
                      onSort={handleSort}
                    >
                      Line
                    </TableHeaderCell>
                    {/* Col 1: Mode badge */}
                    <TableHeaderCell
                      sortKey="mode"
                      sort={sortState}
                      onSort={handleSort}
                    >
                      Mode
                    </TableHeaderCell>
                    <TableHeaderCell
                      sortKey="chats"
                      sort={sortState}
                      onSort={handleSort}
                    >
                      Chats
                    </TableHeaderCell>
                    <TableHeaderCell
                      sortKey="groups"
                      sort={sortState}
                      onSort={handleSort}
                    >
                      Groups
                    </TableHeaderCell>
                    <TableHeaderCell
                      sortKey="unread"
                      sort={sortState}
                      onSort={handleSort}
                    >
                      Unread
                    </TableHeaderCell>
                    <TableHeaderCell
                      sortKey="sent"
                      sort={sortState}
                      onSort={handleSort}
                    >
                      Sent
                    </TableHeaderCell>
                    <TableHeaderCell
                      sortKey="recv"
                      sort={sortState}
                      onSort={handleSort}
                    >
                      Recv
                    </TableHeaderCell>
                    <TableHeaderCell
                      sortKey="tokens"
                      sort={sortState}
                      onSort={handleSort}
                    >
                      Tokens
                    </TableHeaderCell>
                    <TableHeaderCell
                      sortKey="sessions"
                      sort={sortState}
                      onSort={handleSort}
                    >
                      Sessions
                    </TableHeaderCell>
                    <TableHeaderCell
                      sortKey="provider"
                      sort={sortState}
                      onSort={handleSort}
                    >
                      Provider
                    </TableHeaderCell>
                    {/* Not sortable */}
                    <TableHeaderCell>Tags</TableHeaderCell>
                    <TableHeaderCell
                      sortKey="active"
                      sort={sortState}
                      onSort={handleSort}
                    >
                      Active
                    </TableHeaderCell>
                  </tr>
                </TableHeader>

                <TableBody>
                  {fleetLoadError ? (
                    <TableError
                      colSpan={COL_COUNT}
                      message={`Unable to load fleet data: ${fleetLoadErrorMessage}`}
                      retry={
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<RotateCw size={12} strokeWidth={1.75} />}
                          onClick={() => {
                            if (linesError) void refetchLines();
                            if (feedError) void refetchFeed();
                          }}
                        >
                          Retry
                        </Button>
                      }
                    />
                  ) : filtered.length === 0 ? (
                    <TableEmpty
                      colSpan={COL_COUNT}
                      message="No instances match the current filters"
                    />
                  ) : (
                    filtered.map((line) => {
                      const _statusSev = statusSeverity(line.status);
                      const severity: RowSeverity | undefined =
                        _statusSev === "crit" ? "crit" :
                        _statusSev === "warn" ? "warn" :
                        undefined;
                      const isError = _statusSev === "crit";
                      const isCurrent = selectedName === line.name;
                      const sent = line.messageStats?.sent ?? 0;
                      const recv = line.messageStats?.received ?? 0;
                      const lastActiveLabel = line.lastActive ? formatRelative(line.lastActive) : "Never";

                      return (
                        <TableRow
                          key={line.name}
                          interactive
                          severity={severity}
                          current={isCurrent}
                          ref={
                            isCurrent
                              ? (el) => {
                                  if (el) selectedRowRef.current = el;
                                }
                              : undefined
                          }
                          onActivate={() => openDrawer(line.name)}
                        >
                          {/* Col 0: StatusCell shape + name label (C-1 resolution) */}
                          <TableCell>
                            <StatusCell
                              status={line.status}
                              name={displayInstanceName(line.name)}
                            />
                            <span className="c-label">
                              {formatPhone(line.phone)}
                            </span>
                          </TableCell>
                          {/* Col 1: Mode badge kept as separate column */}
                          <TableCell>
                            <ModeBadge mode={line.mode} />
                          </TableCell>
                          <TableCell numeric>
                            <span className="c-data text-t2">
                              {line.chatCounts?.chats ?? 0}
                            </span>
                          </TableCell>
                          <TableCell numeric>
                            <span className="c-data text-t4">
                              {line.chatCounts?.groups ?? 0}
                            </span>
                          </TableCell>
                          <TableCell numeric>
                            {(line.unread ?? 0) > 0 ? (
                              <span className="c-data text-s-warn font-medium">
                                {line.unread}
                              </span>
                            ) : (
                              <span className="c-data text-t5">0</span>
                            )}
                          </TableCell>
                          <TableCell numeric>
                            <span className="c-data" style={{ color: "var(--text-2)" }}>
                              {String.fromCharCode(0x2191)}
                              {sent}
                            </span>
                          </TableCell>
                          <TableCell numeric>
                            <span className="c-data" style={{ color: "var(--text-2)" }}>
                              {String.fromCharCode(0x2193)}
                              {recv}
                            </span>
                          </TableCell>
                          <TableCell numeric>
                            {(line.tokenUsage?.input ?? 0) > 0 ? (
                              <span
                                className="c-data text-t2"
                                title={`${formatCount(line.tokenUsage?.input)} in / ${formatCount(line.tokenUsage?.output)} out`}
                              >
                                {formatCompact(
                                  (line.tokenUsage?.input ?? 0) +
                                    (line.tokenUsage?.output ?? 0)
                                )}
                              </span>
                            ) : (
                              <EM_DASH />
                            )}
                          </TableCell>
                          <TableCell numeric>
                            {line.mode === "agent" ? (
                              <span className="c-data font-medium" style={{ color: "var(--text-2)" }}>
                                {line.totalSessions ?? 0}
                              </span>
                            ) : (
                              <EM_DASH />
                            )}
                          </TableCell>
                          <TableCell>
                            <span
                              className="c-data"
                              style={{
                                color: getProviderColor(
                                  line.provider ?? "claude-cli"
                                ).stroke,
                              }}
                            >
                              {getProvider(line.provider ?? "claude-cli")
                                ?.shortName ?? "Claude"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <LineTags line={line} />
                          </TableCell>
                          <TableCell numeric>
                            <span
                              title={lastActiveLabel}
                              className={`c-data whitespace-nowrap ${isError ? "text-s-crit" : "text-t4"}`}
                            >
                              {line.lastActive ? (
                                lastActiveLabel
                              ) : (
                                <EM_DASH />
                              )}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </DrawerLayout>
        </div>

        {/* Activity Feed */}
        <div className="c-card flex flex-col overflow-hidden min-h-[var(--fleet-pane-min-h)] lg:basis-0 lg:flex-1 lg:min-w-[var(--feed-min-w)]">
          <ActivityFeed
            events={feed}
            error={feedError ? feedLoadErrorMessage : undefined}
            onRetry={feedError ? () => { void refetchFeed() } : undefined}
          />
        </div>
      </motion.div>

      <Suspense fallback={null}>
        {/* C-B3W4-3: latched mount — wizard stays mounted after first open so
            useDismissable can restore focus and Modal's exit motion can play.
            The open prop controls visibility; reset-on-open restores step 0. */}
        {wizardEverOpened && (
          <AddLineWizard
            open={showAddWizard}
            onClose={() => setShowAddWizard(false)}
          />
        )}
      </Suspense>
    </div>
  );
};

export default SoupKitchen;
