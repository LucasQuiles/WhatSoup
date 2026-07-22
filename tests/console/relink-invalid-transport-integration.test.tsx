/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import RelinkModal from '../../console/src/components/RelinkModal';
import { FleetDiscovery } from '../../src/fleet/discovery.ts';
import { enrichInstance } from '../../src/fleet/routes/lines.ts';

const tempDirs: string[] = [];

class FakeEventSource {
  static opened: string[] = [];
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    FakeEventSource.opened.push(String(url));
  }

  addEventListener(): void {}
  close(): void {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.opened.length = 0;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('invalid persisted transport relink composition', () => {
  it('flows discovery through the lines response into Relink without opening QR auth', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-relink-invalid-'));
    tempDirs.push(tempDir);
    const instanceDir = path.join(tempDir, 'future-line');
    fs.mkdirSync(instanceDir, { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'config.json'), JSON.stringify({
      name: 'future-line',
      type: 'chat',
      systemPrompt: 'Test line.',
      adminPhones: ['15551234567'],
      accessMode: 'allowlist',
      healthPort: 9090,
      transport: 'future-provider',
    }));
    vi.stubGlobal('EventSource', FakeEventSource);

    const discovered = new FleetDiscovery(tempDir).scan().get('future-line');
    expect(discovered?.configError).toMatch(/transport/i);
    const line = enrichInstance(discovered!, undefined);
    expect(line).toMatchObject({ status: 'config_error', transport: 'future-provider' });

    render(
      <RelinkModal
        lineName={line.name as string}
        transport={line.transport as string}
        open={true}
        onClose={vi.fn()}
        onLinked={vi.fn()}
      />,
    );
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('Unsupported transport')).toBeDefined();
    expect(screen.queryByText('Scan with WhatsApp')).toBeNull();
    expect(FakeEventSource.opened).toEqual([]);
  });
});
