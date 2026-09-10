/**
 * Wizard agent-cwd display tests — verify ConfigStep cwd input and ReviewStep
 * "CWD" KV row surface the default workspace path returned by
 * console/src/lib/agent-cwd.ts:defaultAgentWorkspacePath().
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../console/src/lib/api', () => ({
  api: {
    getProviders: vi.fn().mockResolvedValue([
      { id: 'claude-cli', displayName: 'Claude CLI', type: 'cli', needsApiKey: false, credentialService: null, providerConfig: [] },
    ]),
    getProviderModels: vi.fn().mockResolvedValue({
      status: 'unavailable',
      reason: { kind: 'no-adapter', harness: 'test' },
      asOfLabel: 'just now',
    }),
  },
}));

import ConfigStep from '../../console/src/components/wizard/ConfigStep';
import ReviewStep from '../../console/src/components/wizard/ReviewStep';
import { defaultAgentWorkspacePath } from '../../console/src/lib/agent-cwd';

const NAME = 'lab-test';
const EXPECTED_DEFAULT = '~/.local/share/whatsoup/instances/lab-test/workspace';
const OVERRIDE = '~/work/custom';

function renderConfigStep(data: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ConfigStep, {
        data,
        onChange: () => {},
        errors: {},
      }),
    ),
  );
}

function openPermissionsTab() {
  const tab = screen.getByRole('tab', { name: 'Permissions' });
  fireEvent.click(tab);
}

function getCwdInput(): HTMLInputElement {
  // Field associates label and input via htmlFor/id (useId). RTL's
  // getByLabelText follows that relationship.
  const input = screen.getByLabelText('Working Directory');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Working Directory input element is not an HTMLInputElement');
  }
  return input;
}

afterEach(() => {
  cleanup();
});

describe('helper agreement (parity with unit suite)', () => {
  it('defaultAgentWorkspacePath produces the expected canonical default', () => {
    expect(defaultAgentWorkspacePath(NAME)).toBe(EXPECTED_DEFAULT);
  });
});

describe('ConfigStep — Permissions tab cwd input', () => {
  beforeEach(() => {
    cleanup();
  });

  it('falls back to the default workspace path when agentOptions.cwd is undefined', () => {
    renderConfigStep({ name: NAME, type: 'agent', agentOptions: {} });
    openPermissionsTab();
    const input = getCwdInput();
    expect(input.value).toBe(EXPECTED_DEFAULT);
    expect(input.placeholder).toBe(EXPECTED_DEFAULT);
  });

  it('preserves an explicit agentOptions.cwd override', () => {
    renderConfigStep({ name: NAME, type: 'agent', agentOptions: { cwd: OVERRIDE } });
    openPermissionsTab();
    const input = getCwdInput();
    expect(input.value).toBe(OVERRIDE);
    // Placeholder still shows the default, since the field's placeholder
    // is name-derived (not value-derived).
    expect(input.placeholder).toBe(EXPECTED_DEFAULT);
  });

  it('uses the placeholder fallback when agentOptions is omitted entirely', () => {
    renderConfigStep({ name: NAME, type: 'agent' });
    openPermissionsTab();
    const input = getCwdInput();
    expect(input.value).toBe(EXPECTED_DEFAULT);
  });
});

function renderReviewStep(data: Record<string, unknown>) {
  return render(
    createElement(ReviewStep, {
      data,
      onEditPhase: () => {},
      onCreateLine: async () => {},
      creating: false,
      error: null,
    }),
  );
}

function getCwdValue(): string {
  // KV row "CWD" sits under the Config card. Locate the label, then read
  // the sibling value span.
  const label = screen.getByText('CWD');
  const row = label.parentElement;
  if (!row) throw new Error('CWD KV row not found');
  const valueSpan = row.querySelector('span.font-mono');
  if (!valueSpan) throw new Error('CWD KV value span not found');
  return valueSpan.textContent ?? '';
}

describe('ReviewStep — Config card CWD row', () => {
  beforeEach(() => {
    cleanup();
  });

  it('displays the default workspace path when agentOptions.cwd is empty', () => {
    renderReviewStep({
      name: NAME,
      type: 'agent',
      agentOptions: { cwd: '', sessionScope: 'per_chat' },
    });
    expect(getCwdValue()).toBe(EXPECTED_DEFAULT);
  });

  it('displays the default workspace path when agentOptions is omitted entirely', () => {
    renderReviewStep({ name: NAME, type: 'agent' });
    expect(getCwdValue()).toBe(EXPECTED_DEFAULT);
  });

  it('displays an explicit cwd override unchanged', () => {
    renderReviewStep({
      name: NAME,
      type: 'agent',
      agentOptions: { cwd: OVERRIDE, sessionScope: 'per_chat' },
    });
    expect(getCwdValue()).toBe(OVERRIDE);
  });
});
