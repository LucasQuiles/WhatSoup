import { type FC, useMemo, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "../components/primitives/Button";
import { TextInput } from "../components/primitives/FormControl";
import { SkillCard } from "../components/skills/SkillCard";
import { PLUGIN_CATALOG, type PluginSource } from "../lib/plugin-catalog";

type TypeFilter = "all" | "plugins" | "skills" | "mcp" | "tools";
type SourceFilter = PluginSource | null;
type SortDir = "asc" | "desc";

/** The catalog carries plugin-type entries only today; skills/MCP/tools
 *  filters render honest zero counts until those entry types land. */
const TYPE_COUNTS: Record<TypeFilter, number> = {
  all: PLUGIN_CATALOG.length,
  plugins: PLUGIN_CATALOG.length,
  skills: 0,
  mcp: 0,
  tools: 0,
};

const TYPE_LABEL: Record<TypeFilter, string> = {
  all: "All",
  plugins: "Plugins",
  skills: "Skills",
  mcp: "MCP servers",
  tools: "Tools",
};

const SOURCE_ORDER: PluginSource[] = ["official", "community", "local", "thirdparty"];
const SOURCE_LABEL: Record<PluginSource, string> = {
  official: "Official",
  community: "Community",
  local: "Local / uploaded",
  thirdparty: "3rd-party",
};

const SkillsHub: FC = () => {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(null);
  const [search, setSearch] = useState("");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const sourceCounts = useMemo(() => {
    const counts: Record<PluginSource, number> = { official: 0, community: 0, local: 0, thirdparty: 0 };
    for (const e of PLUGIN_CATALOG) counts[e.source] += 1;
    return counts;
  }, []);

  const visible = useMemo(() => {
    let list = PLUGIN_CATALOG.slice();
    if (typeFilter !== "all" && typeFilter !== "plugins") return []; // zero-count types, honestly
    if (sourceFilter) list = list.filter((e) => e.source === sourceFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (e) =>
          e.label.toLowerCase().includes(q) ||
          e.key.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => (sortDir === "asc" ? a.label.localeCompare(b.label) : b.label.localeCompare(a.label)));
    return list;
  }, [typeFilter, sourceFilter, search, sortDir]);

  return (
    <div className="skills-page">
      <div className="skills-pagerow">
        <h1>Skills Hub</h1>
        <div className="skills-pagerow__spacer" />
        <div className="skills-modebar" role="group" aria-label="hub scope">
          <Button variant="ghost" className="skills-modebar__btn skills-modebar__btn--on" aria-pressed="true">
            <span className="skills-modebar__st">●</span> personal hub
          </Button>
          <Button
            variant="ghost"
            className="skills-modebar__btn"
            aria-pressed="false"
            disabled
            title="org hub lands with the hub API — no shared catalog endpoint today"
          >
            org hub · shared
          </Button>
        </div>
        <Button
          variant="primary"
          disabled
          title="upload lands with the hub API — no install endpoint today"
        >
          <Upload size={13} aria-hidden="true" /> Upload
        </Button>
      </div>

      <div className="skills-wrap">
        <aside className="skills-filters" aria-label="skill filters">
          <div className="skills-fsec">Type</div>
          {(Object.keys(TYPE_LABEL) as TypeFilter[]).map((t) => (
            <Button
              key={t}
              variant="ghost"
              className={`skills-fitem${typeFilter === t ? " skills-fitem--on" : ""}`}
              aria-pressed={typeFilter === t}
              onClick={() => setTypeFilter(t)}
            >
              {TYPE_LABEL[t]} <span className="skills-fitem__c">{TYPE_COUNTS[t]}</span>
            </Button>
          ))}
          <div className="skills-fsec">Source</div>
          {SOURCE_ORDER.map((s) => (
            <Button
              key={s}
              variant="ghost"
              className={`skills-fitem${sourceFilter === s ? " skills-fitem--on" : ""}`}
              aria-pressed={sourceFilter === s}
              onClick={() => setSourceFilter(sourceFilter === s ? null : s)}
            >
              {SOURCE_LABEL[s]} <span className="skills-fitem__c">{sourceCounts[s]}</span>
            </Button>
          ))}
          <div className="skills-fsec">Legend</div>
          <div className="skills-fitem skills-legend">
            compat
            <br />C claude-cli · O opencode · X codex
            <br />G gemini · A anthropic
            <br />harness
            <br />agt agent · cht chat · pas passive
            <br />◆ partial · ● full · outline n/a
          </div>
        </aside>

        <main className="skills-main">
          <div className="skills-toolbar">
            <div className="skills-search">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5 14 14" />
              </svg>
              <TextInput
                aria-label="Search skills, plugins, MCP servers, tools"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search skills, plugins, MCP servers, tools…"
              />
            </div>
            <Button variant="ghost" onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>
              sort: name {sortDir === "asc" ? "⇅" : "⇵"}
            </Button>
          </div>

          {visible.length === 0 ? (
            <div className="skills-empty" data-testid="skills-empty">
              {search || sourceFilter
                ? "No catalog entries match the current filters."
                : "No entries of this type in the catalog yet — skills, MCP servers, and tools land with the hub API."}
            </div>
          ) : (
            visible.map((e) => <SkillCard key={e.key} entry={e} />)
          )}
        </main>
      </div>
    </div>
  );
};

export default SkillsHub;
