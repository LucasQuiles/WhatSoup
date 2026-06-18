/** @vitest-environment jsdom */
/**
 * Tabs primitive contract (tabs.md):
 * roving tabindex, Arrow/Home/End focus movement with wrap, MANUAL activation
 * (Enter/Space select; focus alone does not switch panels), aria wiring,
 * hidden attribute on unselected panels, disabled-with-reason.
 * Class-only assertions prove the CSS hook exists, not the rendered ink.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Tabs, Tab, TabPanel } from '../../console/src/components/primitives';

afterEach(() => cleanup());

function Harness({ onChange }: { onChange?: (id: string) => void }) {
  const [active, setActive] = useState('one');
  const select = (id: string) => { setActive(id); onChange?.(id); };
  return (
    <>
      <Tabs label="Demo tabs" value={active} onChange={select}>
        <Tab id="one">One</Tab>
        <Tab id="two">Two</Tab>
        <Tab id="three" disabled disabledReason="not configured">Three</Tab>
      </Tabs>
      <TabPanel id="one" active={active}>panel one</TabPanel>
      <TabPanel id="two" active={active}>panel two</TabPanel>
      <TabPanel id="three" active={active}>panel three</TabPanel>
    </>
  );
}

describe('Tabs — roles and aria wiring', () => {
  it('renders tablist with label, tabs with aria-selected/controls, panels with aria-labelledby', () => {
    render(<Harness />);
    const list = screen.getByRole('tablist', { name: 'Demo tabs' });
    expect(list.getAttribute('aria-label')).toBe('Demo tabs');
    const one = screen.getByRole('tab', { name: 'One' });
    expect(one.getAttribute('aria-selected')).toBe('true');
    expect(one.getAttribute('aria-controls')).toBe('tabpanel-one');
    expect(one.id).toBe('tab-one');
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('tab-one');
  });

  it('unselected panels carry the hidden attribute (not unmounted by the primitive)', () => {
    render(<Harness />);
    expect(document.getElementById('tabpanel-two')?.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('tabpanel-one')?.hasAttribute('hidden')).toBe(false);
  });
});

describe('Tabs — roving tabindex + keyboard contract', () => {
  it('selected tab is the only tab in the tab order', () => {
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'One' }).tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Two' }).tabIndex).toBe(-1);
  });

  it('ArrowRight moves focus (with wrap) WITHOUT selecting; Enter selects', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const one = screen.getByRole('tab', { name: 'One' });
    one.focus();
    fireEvent.keyDown(one, { key: 'ArrowRight' });
    const two = screen.getByRole('tab', { name: 'Two' });
    expect(document.activeElement).toBe(two);
    expect(onChange).not.toHaveBeenCalled(); // manual activation
    fireEvent.keyDown(two, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('two');
  });

  it('Home/End jump to first/last; ArrowLeft from first wraps to last', () => {
    render(<Harness />);
    const one = screen.getByRole('tab', { name: 'One' });
    one.focus();
    fireEvent.keyDown(one, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Three/ }));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(one);
    fireEvent.keyDown(one, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Three/ }));
  });

  it('disabled tab: aria-disabled, focusable, not selectable, reason exposed', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const three = screen.getByRole('tab', { name: /Three/ });
    expect(three.getAttribute('aria-disabled')).toBe('true');
    expect(three.tabIndex).toBe(-1); // reachable via arrows, not Tab
    fireEvent.keyDown(three, { key: 'Enter' });
    fireEvent.click(three);
    expect(onChange).not.toHaveBeenCalled();
    const describedBy = three.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('not configured');
  });
});

describe('Tabs — lazyPanels aria-controls (#1057)', () => {
  function LazyHarness() {
    const [active, setActive] = useState('one');
    return (
      <>
        <Tabs label="Lazy tabs" value={active} onChange={setActive} lazyPanels>
          <Tab id="one">One</Tab>
          <Tab id="two">Two</Tab>
        </Tabs>
        {/* Only the active panel is mounted (conditional render, as LineDetail does). */}
        <div role="tabpanel" id={`tabpanel-${active}`} aria-labelledby={`tab-${active}`}>
          panel {active}
        </div>
      </>
    );
  }

  it('inactive tabs omit aria-controls when only the active panel is mounted', () => {
    render(<LazyHarness />);
    const one = screen.getByRole('tab', { name: 'One' }); // active
    const two = screen.getByRole('tab', { name: 'Two' }); // inactive, panel not mounted
    expect(one.getAttribute('aria-controls')).toBe('tabpanel-one'); // points at the live panel
    expect(two.hasAttribute('aria-controls')).toBe(false); // no dangling target
  });

  it('default (no lazyPanels) keeps aria-controls on every tab for TabPanel consumers', () => {
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-controls')).toBe('tabpanel-two');
  });
});
