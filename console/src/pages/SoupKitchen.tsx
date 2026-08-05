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
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLines, useFeed, useLogs } from "../hooks/use-fleet";
import { useTransportStatus } from "../hooks/use-transport-status";
import EmptyState from "../components/EmptyState";
import { useDrawerPlacement } from "../hooks/useViewportPlacement";
import { useFleetMetrics } from "../hooks/use-metrics";
import { computeKpis } from "../lib/compute-kpis";
import type { FeedEvent, LineInstance, Mode } from "../types";
import AlertBanner from "../components/AlertBanner";
import ActivityFeed from "../components/ActivityFeed";
import FilterPill from "../components/FilterPill";
import BulkActionBar from "../components/BulkActionBar";
import ConfirmDialog from "../components/ConfirmDialog";
import { FleetKpis } from "../components/fleet/FleetKpis";
import { LineRow } from "../components/fleet/LineRow";
import { HeartbeatRail } from "../components/fleet/HeartbeatRail";
import { channelKindOf } from "../components/fleet/channel-kind";
import { api } from "../lib/api";
import { useToast } from "../hooks/toast-context";
import { formatRelative } from "../lib/format-time";
import {
  formatPhone,
  displayInstanceName,
  formatCompact,
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
  Button,
  DrawerLayout,
  Drawer,
  DrawerHeader,
  DrawerBody,
  LogStream,
  Menu,
  MenuItem,
  Popover,
  Checkbox,
  StatusCell,
  ModeBadge,
  type SortState,
} from "../components/primitives";
import { TextInput } from "../components/primitives/FormControl";
import { statusNeedsAttention, statusAlertMessage } from "../lib/status-severity";

const ease = [0.22, 1, 0.36, 1] as const;

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

/** Column count for colSpan states (shape, line, channel, agent, mode, state,
 * grants, 7d spark, row menu). */
const COL_COUNT = 9;

const modeFilterOptions: (Mode | "all")[] = ["all", "passive", "chat", "agent"];

const modeTextClass: Record<Mode, string> = {
  passive: "text-m-pas",
  chat: "text-m-cht",
  agent: "text-m-agt",
};

/** Sort menu options — keys restricted to what the v3.5 row anatomy surfaces
 *  (provider/chats/groups sorts dropped with their columns). */
const SORT_OPTIONS: { key: Exclude<SortKey, null>; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "mode", label: "Mode" },
  { key: "unread", label: "Unread" },
  { key: "sent", label: "Messages sent" },
  { key: "recv", label: "Messages received" },
  { key: "tokens", label: "Tokens" },
  { key: "sessions", label: "Sessions" },
  { key: "active", label: "Last active" },
];

const EMPTY_LINES: LineInstance[] = [];
const EMPTY_FEED: FeedEvent[] = [];

/** perf §3 virtualization ruling: the lines table virtualizes above 50 rows
 *  (owner scale N=200); below that, plain render. */
const VIRTUALIZE_ABOVE = 50;
/** Estimated row height for the virtualizer (td padding + single-line
 *  anatomy); rows are fixed-height by construction. */
const ROW_ESTIMATE = 38;

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

  // Narrow/phone viewports get the bottom-sheet placement so the inspector's
  // actions ("Open line", "Close") dock on-screen instead of sitting off the
  // right edge — the reachable action path narrow surfaces previously lacked.
  // Viewport branching routes through the sanctioned placement owner.
  const drawerPlacement = useDrawerPlacement();

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
      placement={drawerPlacement}
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
                  {line.metricAvailability?.chatCounts === 'unavailable' ? '-' : line.chatCounts?.chats ?? <EM_DASH />}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Groups</dt>
                <dd className="soup-drawer-kv__val">
                  {line.metricAvailability?.chatCounts === 'unavailable' ? '-' : line.chatCounts?.groups ?? <EM_DASH />}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Unread</dt>
                <dd className="soup-drawer-kv__val">
                  {line.metricAvailability?.chatCounts === 'unavailable' ? '-' : line.unread ?? <EM_DASH />}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Sent</dt>
                <dd className="soup-drawer-kv__val">
                  {line.metricAvailability?.messageStats === 'unavailable' ? '-' : line.messageStats?.sent ?? <EM_DASH />}
                </dd>
              </div>
              <div className="soup-drawer-kv__row">
                <dt className="soup-drawer-kv__key">Received</dt>
                <dd className="soup-drawer-kv__val">
                  {line.metricAvailability?.messageStats === 'unavailable' ? '-' : line.messageStats?.received ?? <EM_DASH />}
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
// SoupKitchen page — v3.5 Fleet surface (T5 b-03; mockup fleet.html SSOT)
// ---------------------------------------------------------------------------

const SoupKitchen: FC = () => {
  const {
    data: lineData,
    isError: linesError,
    error: linesQueryError,
    refetch: refetchLines,
    freshness: linesFreshness,
  } = useLines();
  const {
    data: feedData,
    isError: feedError,
    error: feedQueryError,
    refetch: refetchFeed,
  } = useFeed();
  const navigate = useNavigate();
  const transport = useTransportStatus();
  const queryClient = useQueryClient();
  const toast = useToast();

  const lines = lineData ?? EMPTY_LINES;
  const feed = feedData ?? EMPTY_FEED;

  // Capability gate for per-row lifecycle actions (Restart / Stop / Delete).
  // The console is already gated behind the session-unlock screen (see
  // useConsoleSession); any reachable operator may manage lines, so the fleet
  // table exposes the row-action Menu. Surfaced as a single boolean — mirroring
  // ActivityFeed's `canAct` — so the menu is hidden wholesale when the
  // capability is withheld, and the gate has one obvious place to tighten.
  const canManageLines = true;
  const fleetLoadError = linesError || feedError;
  const feedLoadErrorMessage = feedQueryError?.message ?? "Unable to load activity feed";
  const fleetLoadErrorMessage =
    linesQueryError?.message ??
    feedQueryError?.message ??
    "Unable to load fleet data";

  const [modeFilter, setModeFilter] = useState<Mode | "all">("all");
  const [search, setSearch] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterAnchorRef = useRef<HTMLButtonElement | null>(null);
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
  // Bulk select: set of line names currently selected for bulk actions.
  // SEPARATE from the drawer's selectedName; the multi-select column must
  // never bleed into the row-click → drawer flow. Toggling a row's checkbox
  // does not change selectedName and toggling selectedName does not affect
  // this set.
  const [selectedNames, setSelectedNames] = useState<Set<string>>(
    () => new Set()
  );
  // Bulk confirm: which destructive action (if any) is awaiting one shared
  // ConfirmDialog. Distinct from the per-row Menu's internal confirm, which
  // only fires for the single-line flow.
  type BulkAction = "stop" | "delete";
  const [pendingBulk, setPendingBulk] = useState<{
    action: BulkAction;
    names: string[];
  } | null>(null);

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

  // Sort menu activation: re-selecting the active key flips direction;
  // selecting a new key sorts descending (heaviest first — ops register).
  const handleSortOption = useCallback(
    (key: Exclude<SortKey, null>) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "desc" ? "asc" : "desc"));
      } else {
        handleSort({ key, dir: "desc" });
      }
    },
    [sortKey, handleSort]
  );

  const kpis = useMemo(() => computeKpis(lines), [lines]);
  // Fleet-level 24h metrics feed exactly one KPI card (Tokens 24h); the v3.5
  // Fleet surface carries no charts (they live at /metrics until b-09a
  // absorbs them into Ops per 02-mapping §2 E4).
  const { data: fleetMetrics } = useFleetMetrics("24h");
  const tokens24h = useMemo(() => {
    if (!fleetMetrics?.meta?.hasTokenData) return null;
    return fleetMetrics.tokenUsage.reduce(
      (sum, b) => sum + b.input + b.output,
      0
    );
  }, [fleetMetrics]);

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

  /** Distinct channel kinds across the fleet — the mockup's "N across M
   *  channels" count line. Goes through the generic-first accessor
   *  (channelKindOf) so transport aliases collapse to one glyph kind and
   *  the legacy Baileys-key read stays in its designated home. */
  const channelCount = useMemo(() => {
    const kinds = new Set(lines.map((l) => channelKindOf(l)));
    return kinds.size;
  }, [lines]);

  const filtered = useMemo(() => {
    let result = lines;

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
  }, [lines, modeFilter, search, sortKey, sortDir]);

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

  // Bulk select handlers — toggling a row's checkbox MUST NOT open the drawer
  // (the checkbox cell stops propagation, see LineRow). The set is keyed
  // on the raw line name (not the display name) so the underlying lifecycle
  // API can consume it without re-deriving keys.
  const toggleSelected = useCallback((name: string, next: boolean) => {
    setSelectedNames((prev) => {
      const updated = new Set(prev);
      if (next) updated.add(name);
      else updated.delete(name);
      return updated;
    });
  }, []);

  const visibleNames = useMemo(
    () => filtered.map((line) => line.name),
    [filtered]
  );

  const allVisibleSelected =
    visibleNames.length > 0 &&
    visibleNames.every((name) => selectedNames.has(name));
  const someVisibleSelected =
    !allVisibleSelected &&
    visibleNames.some((name) => selectedNames.has(name));

  const toggleAllVisible = useCallback(
    (next: boolean) => {
      setSelectedNames((prev) => {
        const updated = new Set(prev);
        if (next) {
          for (const name of visibleNames) updated.add(name);
        } else {
          for (const name of visibleNames) updated.delete(name);
        }
        return updated;
      });
    },
    [visibleNames]
  );

  const clearSelection = useCallback(() => {
    setSelectedNames(new Set());
  }, []);

  // Bulk lifecycle handlers — mirror FleetRowMenu's per-action semantics:
  //   - Restart fires directly (optimistic toast, then success/failure).
  //   - Stop and Delete require ONE shared ConfirmDialog naming the count,
  //     then Promise.allSettled the calls and clear selection.
  const handleBulkRestart = useCallback(() => {
    const names = Array.from(selectedNames);
    if (names.length === 0) return;
    toast.info(`Restarting ${names.length} line${names.length === 1 ? "" : "s"}…`);
    void Promise.allSettled(names.map((n) => api.restart(n))).then(
      (results) => {
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const fail = results.length - ok;
        if (fail === 0) {
          toast.success(
            `Restarted ${ok} line${ok === 1 ? "" : "s"}`
          );
        } else {
          toast.error(
            `Restarted ${ok}, failed ${fail}`
          );
        }
        void queryClient.invalidateQueries({ queryKey: ["lines"] });
      }
    );
  }, [selectedNames, queryClient, toast]);

  const requestBulkStop = useCallback(() => {
    const names = Array.from(selectedNames);
    if (names.length === 0) return;
    setPendingBulk({ action: "stop", names });
  }, [selectedNames]);

  const requestBulkDelete = useCallback(() => {
    const names = Array.from(selectedNames);
    if (names.length === 0) return;
    setPendingBulk({ action: "delete", names });
  }, [selectedNames]);

  const cancelBulk = useCallback(() => {
    setPendingBulk(null);
  }, []);

  const confirmBulk = useCallback(() => {
    const pending = pendingBulk;
    if (!pending) return;
    setPendingBulk(null);
    const count = pending.names.length;
    const verb = pending.action === "stop" ? "Stopping" : "Deleting";
    toast.info(
      `${verb} ${count} line${count === 1 ? "" : "s"}…`
    );
    const calls =
      pending.action === "stop"
        ? pending.names.map((n) => api.stopInstance(n))
        : pending.names.map((n) => api.deleteLine(n));
    void Promise.allSettled(calls).then((results) => {
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const fail = results.length - ok;
      const pastTense = pending.action === "stop" ? "stopped" : "deleted";
      if (fail === 0) {
        toast.success(
          `${pastTense.charAt(0).toUpperCase() + pastTense.slice(1)} ${ok} line${ok === 1 ? "" : "s"}`
        );
      } else {
        toast.error(
          `${pastTense} ${ok}, failed ${fail}`
        );
      }
      // Drop any selected names that no longer exist after a successful delete.
      setSelectedNames((prev) => {
        if (pending.action !== "delete" || prev.size === 0) return prev;
        const updated = new Set(prev);
        for (let i = 0; i < results.length; i += 1) {
          if (results[i].status === "fulfilled") {
            updated.delete(pending.names[i]);
          }
        }
        return updated;
      });
      void queryClient.invalidateQueries({ queryKey: ["lines"] });
    });
  }, [pendingBulk, queryClient, toast]);

  const drawerEl = (
    <FleetDrawer
      selectedName={selectedName}
      lines={lines}
      onClose={closeDrawer}
      onOpenLine={openLine}
      restoreFocus={selectedRowRef}
    />
  );

  // Rows virtualization (perf §3 ruling — the acceptance item for b-03):
  // >50 rows → windowed render with spacer rows preserving <table> semantics;
  // ≤50 → plain render. The hook runs unconditionally; `enabled` gates work.
  const rowsRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- waiver:WVR-016 @tanstack/react-virtual's useVirtualizer is flagged by the react-hooks compiler heuristic but is a stable supported library hook; expires 2026-12-31
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => rowsRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 10,
    enabled: filtered.length > VIRTUALIZE_ABOVE,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const virtualized = filtered.length > VIRTUALIZE_ABOVE && virtualItems.length > 0;

  return (
    <div className="fleet">
      {/* Page row — surface-owned h1 (single-h1 law) + the mockup's primary
          action. The chrome header carries the title span, attention pill,
          and theme toggle above this row. */}
      <div className="fleet-pagerow">
        <h1>Fleet</h1>
        <div className="spacer" />
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={16} strokeWidth={1.75} />}
          onClick={() => { setShowAddWizard(true); setWizardEverOpened(true); }}
        >
          Hatch a line
        </Button>
      </div>

      <FleetKpis
        kpis={kpis}
        lineCount={lines.length}
        tokens24h={tokens24h}
        freshness={linesFreshness}
      />

      <AlertBanner alerts={alerts} />

      {/* Main area — Lines panel + Activity panel (mockup .content grid) */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.1, ease }}
        className="fleet-content"
      >
        <section className="fleet-panel" aria-label="Lines">
          <div className="fleet-panel__h">
            <h2>Lines</h2>
            <span className="fleet-panel__count">
              {filtered.length} across {channelCount} channel{channelCount === 1 ? "" : "s"}
            </span>
            <div className="spacer" />
            <Menu
              label="Sort lines"
              triggerLabel="⇅ sort"
              triggerLabelText={`Sort lines${sortKey ? ` (current: ${sortKey} ${sortDir})` : ""}`}
            >
              {SORT_OPTIONS.map((o) => (
                <MenuItem key={o.key} onSelect={() => handleSortOption(o.key)}>
                  {o.label}
                  {sortKey === o.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                </MenuItem>
              ))}
            </Menu>
            <Button
              variant="ghost"
              size="sm"
              ref={filterAnchorRef}
              aria-haspopup="dialog"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((v) => !v)}
            >
              filter{modeFilter !== "all" || search ? ` · ${modeFilter !== "all" ? modeFilter : "search"}` : ""}
            </Button>
            <Popover
              open={filterOpen}
              onClose={() => setFilterOpen(false)}
              anchorRef={filterAnchorRef}
              aria-label="Line filters"
            >
              <div className="fleet-filterpop">
                <div className="fleet-filterpop__modes">
                  {modeFilterOptions.map((m) => (
                    <FilterPill
                      key={m}
                      label={m === "all" ? "All" : m}
                      isActive={modeFilter === m}
                      activeColor={m === "all" ? "text-text-2" : modeTextClass[m]}
                      onClick={() => setModeFilter(m)}
                      count={modeCounts[m]}
                    />
                  ))}
                </div>
                <TextInput
                  type="search"
                  className="fleet-filterpop__search"
                  aria-label="Search lines"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search lines..."
                />
              </div>
            </Popover>
          </div>

          {/* Bulk action bar — surfaces only with ≥1 selected row (the bar
              itself also null-renders at 0). The selection path is the
              hover/focus reveal on the leading shape cell. */}
          {canManageLines && (
            <BulkActionBar
              count={selectedNames.size}
              onRestart={handleBulkRestart}
              onStop={requestBulkStop}
              onDelete={requestBulkDelete}
              onClear={clearSelection}
            />
          )}

          {/* DrawerLayout — squeeze: table is flex sibling of the drawer at ≥1080px */}
          <DrawerLayout
            className="flex-1 min-h-0 overflow-hidden"
            drawer={drawerEl}
          >
            <div className="fleet-rows" ref={rowsRef}>
              <Table density="compressed" className="fleet-table">
                <TableHeader>
                  <tr>
                    <TableHeaderCell aria-label="Status">
                      {canManageLines && (
                        <span
                          className={`fleet-select fleet-select--all${
                            selectedNames.size > 0 ? " fleet-select--on" : ""
                          }`}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            checked={allVisibleSelected}
                            indeterminate={someVisibleSelected}
                            onChange={toggleAllVisible}
                            label="Select all lines"
                            disabled={visibleNames.length === 0}
                          />
                        </span>
                      )}
                    </TableHeaderCell>
                    <TableHeaderCell>Line</TableHeaderCell>
                    <TableHeaderCell>Channel</TableHeaderCell>
                    <TableHeaderCell>Agent</TableHeaderCell>
                    <TableHeaderCell>Mode</TableHeaderCell>
                    <TableHeaderCell>State</TableHeaderCell>
                    <TableHeaderCell>Grants</TableHeaderCell>
                    <TableHeaderCell>7d</TableHeaderCell>
                    <TableHeaderCell>
                      <span className="sr-only">Actions</span>
                    </TableHeaderCell>
                  </tr>
                </TableHeader>
                <TableBody>
                  {fleetLoadError && transport.isDisconnected ? (
                    // Transport drop: read as offline-with-cache, not a hard
                    // failure (DD-29). The error branch below still owns genuine
                    // errors while connected.
                    <TableRow>
                      <TableCell colSpan={COL_COUNT}>
                        <EmptyState
                          variant="offline"
                          title="Showing cached data"
                          description="Reconnecting…"
                        />
                      </TableCell>
                    </TableRow>
                  ) : fleetLoadError ? (
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
                  ) : virtualized ? (
                    <>
                      <TableRow aria-hidden="true">
                        <TableCell colSpan={COL_COUNT} style={{ padding: 0, border: 0, height: virtualItems[0].start }} />
                      </TableRow>
                      {virtualItems.map((vi) => {
                        const line = filtered[vi.index];
                        return (
                          <LineRow
                            key={line.name}
                            line={line}
                            current={selectedName === line.name}
                            selected={selectedNames.has(line.name)}
                            canManage={canManageLines}
                            onActivate={openDrawer}
                            onToggleSelected={toggleSelected}
                            rowRef={selectedRowRef}
                          />
                        );
                      })}
                      <TableRow aria-hidden="true">
                        <TableCell
                          colSpan={COL_COUNT}
                          style={{
                            padding: 0,
                            border: 0,
                            height:
                              virtualizer.getTotalSize() -
                              virtualItems[virtualItems.length - 1].end,
                          }}
                        />
                      </TableRow>
                    </>
                  ) : (
                    filtered.map((line) => (
                      <LineRow
                        key={line.name}
                        line={line}
                        current={selectedName === line.name}
                        selected={selectedNames.has(line.name)}
                        canManage={canManageLines}
                        onActivate={openDrawer}
                        onToggleSelected={toggleSelected}
                        rowRef={selectedRowRef}
                      />
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </DrawerLayout>
        </section>

        {/* Activity panel — feed + heartbeat rail (mockup right column) */}
        <section className="fleet-panel" aria-label="Activity">
          <div className="fleet-panel__h">
            <h2>Activity</h2>
            <span className="fleet-panel__count">live</span>
          </div>
          <div className="fleet-feed">
            <ActivityFeed
              events={feed}
              error={feedError ? feedLoadErrorMessage : undefined}
              onRetry={feedError ? () => { void refetchFeed() } : undefined}
            />
          </div>
          <HeartbeatRail lines={lines} />
        </section>
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

      {/* Bulk confirm — ONE shared ConfirmDialog for the destructive bulk
          actions (Stop / Delete), naming the count. The per-row Menu's
          internal confirm remains the single-line path. */}
      <ConfirmDialog
        open={pendingBulk !== null}
        title={
          pendingBulk?.action === "delete"
            ? `Delete ${pendingBulk.names.length} line${
                pendingBulk.names.length === 1 ? "" : "s"
              }?`
            : `Stop ${pendingBulk?.names.length ?? 0} line${
                (pendingBulk?.names.length ?? 0) === 1 ? "" : "s"
              }?`
        }
        confirmVariant="danger"
        confirmLabel={
          pendingBulk?.action === "delete"
            ? "Delete permanently"
            : "Stop lines"
        }
        onCancel={cancelBulk}
        onConfirm={confirmBulk}
      >
        {pendingBulk?.action === "delete" ? (
          <>
            This will stop the process, remove all configuration, data, and
            message history for{" "}
            <strong>
              {pendingBulk.names
                .map((n) => displayInstanceName(n))
                .join(", ")}
            </strong>
            . This cannot be undone.
          </>
        ) : (
          <>
            Stopping will disconnect the following lines from their channels. The
            lines will not reconnect until manually started:{" "}
            <strong>
              {pendingBulk?.names
                .map((n) => displayInstanceName(n))
                .join(", ")}
            </strong>
            .
          </>
        )}
      </ConfirmDialog>
    </div>
  );
};

export default SoupKitchen;
