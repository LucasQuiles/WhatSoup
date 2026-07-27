import type { FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../primitives/Button';
import type { PluginCatalogEntry } from '../../lib/plugin-catalog';

/* Compat vocabulary (mockup skills-hub.html legend): five provider cells +
   three harness cells per entry. NO assessment data exists today — every
   cell renders the honest n/a outline, and the gnote says why. The anatomy
   (cell sets, labels, diamond/ok/none recipes) is the bead's acceptance
   item; real verdicts land with the hub assessment API. */

const PROVIDER_CELLS = [
  { id: 'C', title: 'claude-cli' },
  { id: 'O', title: 'opencode-cli' },
  { id: 'X', title: 'codex-cli' },
  { id: 'G', title: 'gemini-cli' },
  { id: 'A', title: 'anthropic-api' },
] as const;

const HARNESS_CELLS = [
  { id: 'agt', title: 'agent' },
  { id: 'cht', title: 'chat' },
  { id: 'pas', title: 'passive' },
] as const;

const SOURCE_LABEL: Record<PluginCatalogEntry['source'], string> = {
  official: 'official',
  community: 'community',
  local: 'local',
  thirdparty: '3rd-party',
};

/** Category → glyph (mockup .sicon): simple shapes per catalog category. */
const CategoryGlyph: FC<{ category: PluginCatalogEntry['category'] }> = ({ category }) => {
  switch (category) {
    case 'core':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.5 14 5v6l-6 3.5L2 11V5z" />
        </svg>
      );
    case 'dev':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2a6 6 0 1 0 6 6h-2a4 4 0 1 1-4-4z" />
          <path d="M8 6l5-3-3 5z" />
        </svg>
      );
    case 'integration':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1 3h14v10H1z" />
        </svg>
      );
    case 'lsp':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 3h12v9H6l-4 3z" />
        </svg>
      );
  }
};

export const SkillCard: FC<{ entry: PluginCatalogEntry }> = ({ entry }) => {
  const navigate = useNavigate();
  return (
    <div className="skills-scard" data-testid={`skill-card-${entry.key}`}>
      <div className="skills-scard__top">
        <span className="skills-sicon">
          <CategoryGlyph category={entry.category} />
        </span>
        <div className="skills-scard__nameblock">
          <div className="skills-scard__nm">{entry.label}</div>
          <div className="skills-scard__desc">{entry.description}</div>
        </div>
        <span className={`skills-src skills-src--${entry.source}`}>{SOURCE_LABEL[entry.source]}</span>
        <div className="skills-scard__acts">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/agents')}
            title="Plugin enablement is managed per agent (Agents surface)"
          >
            manage
          </Button>
        </div>
      </div>
      {entry.source === 'thirdparty' ? (
        <div className="skills-warnnote" role="note">
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2.5 14.5 13.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8 7v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11.6" r=".9" fill="currentColor" stroke="none" />
          </svg>
          <span>
            <b>Third-party publisher code.</b> This entry comes from an unverified source. Reviewed
            install is required — never pre-selected for any agent.
          </span>
        </div>
      ) : null}
      <div className="skills-compat">
        <span className="skills-compat__lbl">COMPAT</span>
        <span className="skills-cset">
          {PROVIDER_CELLS.map((c) => (
            <span className="skills-cdot skills-cdot--na" key={c.id} title={`${c.title}: not assessed`}>
              {c.id}
            </span>
          ))}
        </span>
        <span className="skills-compat__lbl">HARNESS</span>
        <span className="skills-cset">
          {HARNESS_CELLS.map((c) => (
            <span className="skills-cdot skills-cdot--na" key={c.id} title={`${c.title}: not assessed`}>
              {c.id}
            </span>
          ))}
        </span>
        <span className="skills-compat__gnote">compat assessment lands with the hub API</span>
      </div>
    </div>
  );
};
