/**
 * ChromeHeader — v3.5 chrome header (T5 b-02; mockup main > header).
 *
 * Page title (Bricolage, --tracking-chrome-title), attention pill when lines
 * need attention, spacer, and the rightmost theme toggle (sun SVG + mono
 * label). Page-level actions (primary CTA, sort/filter) land with the
 * surface beads b-03+ — b-02 owns only the chrome register.
 *
 * h1 law: exactly one h1 per page, and the page surface owns it (Fleet,
 * Inbox, Ops, LineDetail, and the b-02 stubs each render their own). The
 * chrome title is always a styled span — visible register, aria-hidden so
 * screen readers hear only the surface's h1. Pinned by the D1.3 app-shell
 * landmark contract (tests/browser/a11y-contracts.test.tsx).
 */
import { type FC } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useTheme } from '../../hooks/use-theme';
import { Button } from '../primitives/Button';
import { routeMeta } from './route-meta';
import { SunGlyph } from './glyphs';

interface ChromeHeaderProps {
  alertCount?: number;
}

const ChromeHeader: FC<ChromeHeaderProps> = ({ alertCount = 0 }) => {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const { name: lineName } = useParams<'name'>();
  const { title } = routeMeta(location.pathname);
  const onLineDetail = location.pathname.startsWith('/lines/');
  const titleText = onLineDetail && lineName ? lineName : title;

  return (
    <header className="chrome-header">
      <span className="chrome-title" aria-hidden="true">
        {titleText}
      </span>

      {alertCount > 0 && (
        <Link to="/" className="chrome-attn">
          {alertCount} {alertCount === 1 ? 'line' : 'lines'} need
          {alertCount === 1 ? 's' : ''} attention
        </Link>
      )}

      <div className="chrome-spacer" />

      <Button
        variant="ghost"
        onClick={toggleTheme}
        className="chrome-theme-toggle"
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        icon={<SunGlyph />}
      >
        theme
      </Button>
    </header>
  );
};

export default ChromeHeader;
