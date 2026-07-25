import {
  type FC,
  useMemo,
  useState,
  lazy,
  Suspense,
} from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
const AddLineWizard = lazy(() => import("../components/AddLineWizard"));
import { useLines, useLine, useLiveSessions, useProviderStatus } from "../hooks/use-fleet";
import EmptyState from "../components/EmptyState";
import { TextInput } from "../components/primitives/FormControl";
import { Button } from "../components/primitives/Button";
import { AgentAvatar, AgentPresenceShape, type AgentPresence } from "../components/agents/AgentAvatar";
import { RosterCard } from "../components/agents/RosterCard";
import {
  BrainPanel,
  ToolsPanel,
  AssignedLinesPanel,
  InstancesPanel,
  SkillsPanel,
  MemoryPanel,
} from "../components/agents/panels";
import { isLineConnected } from "../lib/compute-kpis";
import { statusSeverity } from "../lib/status-severity";
import { formatRelative } from "../lib/format-time";
import { formatPhone, displayInstanceName } from "../lib/text-utils";
import type { LineInstance } from "../types";

/** Channel label for the assigned-line row: the line's generic transport
 *  kind, capitalized (baileys → Baileys). Merge seam: when the b-03 fleet
 *  bead lands, CHANNEL_LABEL/channel-kind.ts becomes the designated home for
 *  per-transport display names — switch this import then. */
function channelLabelOf(line: LineInstance): string {
  const kind = line.health?.transport?.kind;
  if (!kind) return "channel";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Runtime → presence mapping (12-agent-identity §4): live = connected now;
 *  paused = degraded/stale (warn diamond); deactivated = unreachable/offline
 *  (recessed outline). `draft` is a hatch-journey state — the runtime has no
 *  draft agents, so it never renders from data. */
function presenceOf(line: LineInstance): AgentPresence {
  if (isLineConnected(line)) return "live";
  const sev = statusSeverity(line.status);
  if (sev === "warn") return "paused";
  return "deactivated";
}

/** Persona soul line: the first real sentence of the config's claudeMd when
 *  one exists (that file IS the persona today). Never fabricated. */
function soulOf(config: Record<string, unknown> | undefined): string | null {
  const raw = config?.claudeMd;
  if (typeof raw !== "string") return null;
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  if (!line) return null;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

const Agents: FC = () => {
  const navigate = useNavigate();
  const { data: lines = [] } = useLines();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hatchOpen, setHatchOpen] = useState(false);
  const [hatchEverOpened, setHatchEverOpened] = useState(false);
  const openHatch = () => {
    setHatchEverOpened(true);
    setHatchOpen(true);
  };

  const agents = useMemo(() => lines.filter((l) => l.mode === "agent"), [lines]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        displayInstanceName(l.name).toLowerCase().includes(q) ||
        (l.phone ?? "").toLowerCase().includes(q),
    );
  }, [agents, search]);

  const selected = useMemo(() => {
    if (selectedName) {
      const found = agents.find((l) => l.name === selectedName);
      if (found) return found;
    }
    return agents[0] ?? null;
  }, [agents, selectedName]);

  const { data: detail } = useLine(selected?.name ?? "");
  const { data: providerStatus } = useProviderStatus(selected?.name ?? "");
  const { data: liveSessions } = useLiveSessions(selected?.name ?? "");

  const config = useMemo(() => {
    const c = (detail as { config?: unknown } | undefined)?.config;
    return typeof c === "object" && c !== null && !Array.isArray(c)
      ? (c as Record<string, unknown>)
      : undefined;
  }, [detail]);

  const soul = soulOf(config);
  const selectedDisplay = selected ? displayInstanceName(selected.name) : null;

  return (
    <div className="agents-page">
      <div className="agents-pagerow">
        <h1>Agents</h1>
        {selectedDisplay ? (
          <span className="agents-crumb">ROSTER / {selectedDisplay}</span>
        ) : null}
        <div className="agents-pagerow__spacer" />
        <Button variant="primary" onClick={openHatch}>
          <Plus size={14} aria-hidden="true" /> Hatch agent
        </Button>
      </div>

      <div className="agents-wrap">
        <aside className="agents-roster" aria-label="agent roster">
          <div className="agents-search">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5 14 14" />
            </svg>
            <TextInput
              aria-label="Search agents"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents…"
            />
          </div>

          {agents.length === 0 ? (
            <div className="agents-roster__empty">
              <EmptyState
                title="No agents hatched yet"
                description="Lines in agent mode appear here. Hatch one to get started."
              />
            </div>
          ) : filtered.length === 0 ? (
            <div className="agents-empty">No agents match “{search}”.</div>
          ) : (
            filtered.map((line) => {
              const display = displayInstanceName(line.name);
              const presence = presenceOf(line);
              const meta = [
                "agent",
                [
                  line.lastActive ? `active ${formatRelative(line.lastActive)}` : null,
                  line.messagesTotal != null ? `${line.messagesTotal} msgs` : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              ];
              return (
                <RosterCard
                  key={line.name}
                  name={line.name}
                  displayName={display}
                  presence={presence}
                  meta={meta}
                  selected={selected?.name === line.name}
                  onSelect={setSelectedName}
                />
              );
            })
          )}

          <Button
            variant="ghost"
            className="agents-acard agents-acard--hatch"
            onClick={openHatch}
          >
            <span className="agents-acard__top">
              <span className="agents-av agents-acard__av" aria-hidden="true">
                ＋
              </span>
              <span>
                <span className="agents-acard__nm">Hatch an agent</span>
                <span className="agents-acard__kind">
                  kind · channel · persona
                </span>
              </span>
            </span>
          </Button>
        </aside>

        <section className="agents-detail" aria-label={selectedDisplay ? `agent detail: ${selectedDisplay}` : "agent detail"}>
          {selected && selectedDisplay ? (
            <>
              <div className="agents-dhead">
                <AgentAvatar name={selectedDisplay} size="xl" />
                <div className="agents-dhead__body">
                  <div className="agents-dhead__titlerow">
                    <h2>{selectedDisplay}</h2>
                    <span className={`agents-pill agents-pill--${presenceOf(selected) === "live" ? "live" : presenceOf(selected) === "paused" ? "paused" : "off"}`}>
                      <AgentPresenceShape presence={presenceOf(selected)} labeled={false} />
                      {presenceOf(selected)}
                    </span>
                  </div>
                  {soul ? <div className="agents-dhead__soul">“{soul}”</div> : null}
                  <div className="agents-dhead__sub">
                    agent mode · {providerStatus?.primary?.provider ?? "provider …"} · sandbox per chat
                  </div>
                </div>
                <div className="agents-dhead__actions">
                  <Button
                    variant="neutral"
                    size="sm"
                    onClick={() => navigate(`/lines/${encodeURIComponent(selected.name)}`)}
                  >
                    Open line
                  </Button>
                </div>
              </div>

              <div className="agents-grid">
                <BrainPanel lineName={selected.name} status={providerStatus} />
                <ToolsPanel lineName={selected.name} config={config} />
                <AssignedLinesPanel
                  displayName={selectedDisplay}
                  phone={selected.phone ? formatPhone(selected.phone) : null}
                  channelLabel={channelLabelOf(selected)}
                />
                <InstancesPanel
                  sessions={liveSessions?.sessions}
                  probeError={liveSessions?.probeError === true}
                />
                <SkillsPanel config={config} />
                <MemoryPanel config={config} />
              </div>
            </>
          ) : (
            <EmptyState
              title="Select an agent"
              description="Pick an agent from the roster to inspect its brain, tools, lines, instances, skills, and memory."
            />
          )}
        </section>
      </div>

      <Suspense fallback={null}>
        {/* latched mount (C-B3W4-3 pattern): open prop drives visibility so
            exit motion can play and focus restores */}
        {hatchEverOpened ? (
          <AddLineWizard open={hatchOpen} onClose={() => setHatchOpen(false)} />
        ) : null}
      </Suspense>
    </div>
  );
};

export default Agents;
