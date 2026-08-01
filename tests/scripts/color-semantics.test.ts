import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-color-semantics.mjs');
const PACKAGE_JSON = resolve(process.cwd(), 'console/package.json');
const PROMOTED_RULES = [
  'soup/data-series-token-only',
  'soup/no-component-local-palette',
  'soup/provider-palette-only',
  'soup/traffic-neutrality',
];

const tmp = trackTmpDirs('color-');

function makeFixture(files: Record<string, string>) {
  const root = tmp.make('semantics');
  for (const [filePath, source] of Object.entries(files)) {
    const absolute = join(root, filePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  return root;
}

function runScript(root: string, extraArgs: string[] = []) {
  return spawnSync(
    'node',
    [SCRIPT, '--root', root, '--max-findings', '50', ...extraArgs],
    {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function promotedRuleArgs() {
  return PROMOTED_RULES.flatMap((rule) => ['--fail-on-rule', rule]);
}

function parsedOutput(result: ReturnType<typeof runScript>) {
  return JSON.parse(result.stdout) as {
    by_rule: Record<string, number>;
    enforced_rules: string[];
    failed_rules: string[];
    finding_count: number;
    findings: Array<{ rule: string; file: string; line: number }>;
    mode: 'report-only' | 'fail-on-findings' | 'fail-on-rule';
    scanned_file_count: number;
    verdict: 'PASS' | 'FAIL';
  };
}

describe('check-color-semantics.mjs', () => {
  it('keeps the package script blocking every promoted color-semantics rule', () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = packageJson.scripts['design:color-semantics'];

    for (const rule of PROMOTED_RULES) {
      expect(script).toContain(`--fail-on-rule ${rule}`);
    }
  });

  it('reports provider, data-series, traffic, and local-palette drift in report-only mode', () => {
    const root = makeFixture({
      'console/src/lib/providers.ts': `
export const PROVIDER_COLORS = {
  'codex-cli': { stroke: 'var(--color-s-ok)', fill: 'var(--color-s-ok)' },
};
`,
      'console/src/components/FleetMetricsChart.tsx': `
export function FleetMetricsChart() {
  return <Area dataKey="inbound" stroke="var(--color-m-cht)" fill="var(--color-m-cht)" />;
}
`,
      'console/src/pages/SoupKitchen.tsx': `
export function SoupKitchen() {
  return (
    <KpiCard
      value="12"
      label="Messages Sent"
      color="text-m-cht"
    />
  );
}
`,
      'console/src/components/KpiCard.tsx': `
const colorMap: Record<string, string> = {
  'text-m-cht': 'var(--color-m-cht)',
};
`,
    });
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.mode).toBe('report-only');
    expect(output.by_rule).toMatchObject({
      'soup/data-series-token-only': 1,
      'soup/no-component-local-palette': 1,
      'soup/provider-palette-only': 1,
      'soup/traffic-neutrality': 1,
    });
    expect(output.finding_count).toBe(4);
  });

  it('fails every promoted rule when a planted violation reaches the blocking config', () => {
    const root = makeFixture({
      'console/src/lib/providers.ts': `
export const PROVIDER_COLORS = {
  'codex-cli': { stroke: 'var(--color-s-ok)', fill: 'var(--color-s-ok)' },
};
`,
      'console/src/components/FleetMetricsChart.tsx': `
export function FleetMetricsChart() {
  return <Area dataKey="inbound" stroke="var(--color-m-cht)" fill="var(--color-m-cht)" />;
}
`,
      'console/src/pages/SoupKitchen.tsx': `
export function SoupKitchen() {
  return <KpiCard value="12" label="Messages Sent" color="text-m-cht" />;
}
`,
      'console/src/components/KpiCard.tsx': `
const colorMap: Record<string, string> = {
  ok: 'var(--status-ok-solid)',
};
`,
    });
    const result = runScript(root, promotedRuleArgs());
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mode).toBe('fail-on-rule');
    expect(output.enforced_rules).toEqual(PROMOTED_RULES);
    expect(output.failed_rules).toEqual(PROMOTED_RULES);
    expect(output.by_rule).toEqual({
      'soup/data-series-token-only': 1,
      'soup/no-component-local-palette': 1,
      'soup/provider-palette-only': 1,
      'soup/traffic-neutrality': 1,
    });
  });

  it('stays silent for provider, data-series, and neutral traffic token paths', () => {
    const root = makeFixture({
      'console/src/lib/providers.ts': `
export const PROVIDER_COLORS = {
  'codex-cli': { stroke: 'var(--provider-codex)', fill: 'var(--provider-codex)' },
};
`,
      'console/src/components/FleetMetricsChart.tsx': `
export function FleetMetricsChart() {
  return <Area dataKey="inbound" stroke="var(--data-inbound)" fill="var(--data-inbound)" />;
}
`,
      'console/src/pages/SoupKitchen.tsx': `
export function SoupKitchen() {
  return (
    <>
      <KpiCard
        value="12"
        label="Messages Sent"
        color="text-t2"
      />
      <KpiCard
        value="12"
        label="Messages Received"
        color="neutral"
      />
    </>
  );
}
`,
      'console/src/lib/color-semantics.ts': `
export const KPI_COLOR_TOKENS = {
  'text-m-cht': 'var(--mode-chat-solid)',
};
`,
    });
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.finding_count).toBe(0);
    expect(output.scanned_file_count).toBe(4);
  });

  it('can fail when findings are promoted from report-only to blocking mode', () => {
    const root = makeFixture({
      'console/src/components/MetricsChart.tsx': `
export function MetricsChart() {
  return <Bar dataKey="media" fill="var(--color-s-warn)" />;
}
`,
    });
    const result = runScript(root, ['--fail-on-findings']);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mode).toBe('fail-on-findings');
    expect(output.by_rule).toEqual({ 'soup/data-series-token-only': 1 });
    expect(output.enforced_rules).toEqual(['*']);
    expect(output.failed_rules).toEqual(['soup/data-series-token-only']);
  });

  it('can promote a single zeroed rule while unrelated findings remain report-only', () => {
    const root = makeFixture({
      'console/src/components/FleetTokenChart.tsx': `
export function FleetTokenChart() {
  return <Area dataKey="tokens" stroke="var(--color-m-agt)" />;
}
`,
    });
    const result = runScript(root, ['--fail-on-rule', 'soup/no-component-local-palette']);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.mode).toBe('fail-on-rule');
    expect(output.enforced_rules).toEqual(['soup/no-component-local-palette']);
    expect(output.failed_rules).toEqual([]);
    expect(output.by_rule).toEqual({ 'soup/data-series-token-only': 1 });
  });

  it('reports chart-adjacent MetricsTab arbitrary classes that borrow mode colors for data series', () => {
    const root = makeFixture({
      'console/src/components/line-detail/MetricsTab.tsx': `
export function MetricsTab() {
  return <div className="flex-1 bg-[var(--color-m-agt)]" />;
}
`,
    });
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.by_rule).toEqual({ 'soup/data-series-token-only': 1 });
    expect(output.findings[0]?.file).toBe('console/src/components/line-detail/MetricsTab.tsx');
  });

  it('stays silent for MetricsTab arbitrary classes that consume data-series tokens', () => {
    const root = makeFixture({
      'console/src/components/line-detail/MetricsTab.tsx': `
export function MetricsTab() {
  return <div className="flex-1 bg-[var(--data-token-output-solid)]" />;
}
`,
    });
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.finding_count).toBe(0);
  });

  it('fails when the promoted local-palette rule regresses', () => {
    const root = makeFixture({
      'console/src/components/KpiCard.tsx': `
const colorMap: Record<string, string> = {
  ok: 'var(--status-ok-solid)',
};
`,
      'console/src/components/FleetTokenChart.tsx': `
export function FleetTokenChart() {
  return <Area dataKey="tokens" stroke="var(--color-m-agt)" />;
}
`,
    });
    const result = runScript(root, ['--fail-on-rule', 'soup/no-component-local-palette']);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mode).toBe('fail-on-rule');
    expect(output.enforced_rules).toEqual(['soup/no-component-local-palette']);
    expect(output.failed_rules).toEqual(['soup/no-component-local-palette']);
    expect(output.by_rule).toMatchObject({
      'soup/data-series-token-only': 1,
      'soup/no-component-local-palette': 1,
    });
  });

  it('flags local palette maps outside component and page directories', () => {
    const root = makeFixture({
      'console/src/lib/log-theme.ts': `
export const levelColor: Record<string, string> = {
  warn: 'text-s-warn',
};
`,
    });
    const result = runScript(root, ['--fail-on-rule', 'soup/no-component-local-palette']);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.failed_rules).toEqual(['soup/no-component-local-palette']);
    expect(output.by_rule).toEqual({ 'soup/no-component-local-palette': 1 });
    expect(output.findings[0]).toMatchObject({
      file: 'console/src/lib/log-theme.ts',
      rule: 'soup/no-component-local-palette',
    });
  });

  it('supports repeated scan directories for focused inventories', () => {
    const root = makeFixture({
      'console/src/components/FleetMetricsChart.tsx': '<Area dataKey="inbound" stroke="var(--color-m-cht)" />\n',
      'console/fixtures/FleetMetricsChart.tsx': '<Area dataKey="outbound" stroke="var(--color-s-warn)" />\n',
    });
    const result = spawnSync(
      'node',
      [
        SCRIPT,
        '--root',
        root,
        '--scan-dir',
        'console/src',
        '--scan-dir',
        'console/fixtures',
      ],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.finding_count).toBe(2);
    expect(output.scanned_file_count).toBe(2);
  });

  it('fails closed on an empty scan (zero files = broken glob, never a silent PASS)', () => {
    const root = makeFixture({});
    const result = runScript(root);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.scanned_file_count).toBe(0);
    expect(output.verdict).toBe('FAIL');
  });
});
