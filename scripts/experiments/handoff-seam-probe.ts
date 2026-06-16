/**
 * Handoff seam probe — empirical per-model system-prompt-vs-first-turn honoring.
 *
 * Standalone experiment (NOT imported by the live turn path). For each cheap model
 * (deepseek / minimax / glm) it measures whether a sentinel fact placed in the
 * SYSTEM role is recalled as reliably as the same fact placed in the first USER turn.
 * The result drives the per-provider injection-seam routing constant for the warm
 * handoff distiller (see docs/specs/2026-06-16-handoff-distiller-wiring-design.md).
 *
 * Decision rule per model:
 *   system_recall ≈ user_recall  → seam 'system'    (system-prompt injection honored)
 *   system_recall <  user_recall → seam 'first-turn' (must ride the first turn instead)
 *
 * Safety: sends only a synthetic nonce (no real conversation data); reads API keys
 * from the environment (never logs them); per-call timeout with abort; every failure
 * mode (HTTP error, timeout, malformed body, missing key) degrades to a recorded
 * outcome and never throws the run.
 *
 * Run:  set -a; . ~/.config/secrets/deepseek.env; . ~/.config/secrets/minimax.env; \
 *         . ~/.config/secrets/zai.env; set +a; \
 *       node --experimental-strip-types scripts/experiments/handoff-seam-probe.ts
 */

interface ModelTarget {
  id: string;
  label: string;
  endpoint: string;
  model: string;
  keyEnv: string;
}

const TARGETS: ModelTarget[] = [
  { id: 'deepseek', label: 'deepseek-chat', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', keyEnv: 'DEEPSEEK_API_KEY' },
  { id: 'minimax', label: 'MiniMax-M2.7', endpoint: 'https://api.minimax.io/v1/text/chatcompletion_v2', model: 'MiniMax-M2.7', keyEnv: 'MINIMAX_API_KEY' },
  { id: 'glm', label: 'glm-5.2', endpoint: 'https://api.z.ai/api/coding/paas/v4/chat/completions', model: 'glm-5.2', keyEnv: 'ZAI_API_KEY' },
];

const REPEATS = 3;
const CALL_TIMEOUT_MS = 45_000;

type Arm = 'system' | 'first-turn';
type CallOutcome = 'recalled' | 'missed' | 'timeout' | 'error' | 'no-key';

interface ArmResult {
  arm: Arm;
  outcomes: CallOutcome[];
  rawResponses: (string | undefined)[]; // evidence for debugging missed verdicts
  recalls: number; // count of 'recalled'
  valid: number; // count of calls that produced a usable verdict (recalled|missed)
}

interface ModelResult {
  id: string;
  label: string;
  system: ArmResult;
  firstTurn: ArmResult;
  seam: Arm | 'inconclusive' | 'skipped';
}

/** A unique-ish sentinel per run/arm/repeat without Date.now()/Math.random(). */
function sentinel(modelId: string, arm: Arm, i: number): string {
  return `HANDOFF-${modelId.toUpperCase()}-${arm === 'system' ? 'S' : 'U'}${i}-7F3A9`;
}

function buildMessages(arm: Arm, code: string): Array<{ role: string; content: string }> {
  const fact = `Operational note: the access code for this session is ${code}. Keep it available.`;
  const probe = 'What is the access code for this session? Reply with only the code.';
  if (arm === 'system') {
    return [{ role: 'system', content: fact }, { role: 'user', content: probe }];
  }
  return [{ role: 'user', content: `${fact}\n\n${probe}` }];
}

async function callModel(t: ModelTarget, key: string, messages: Array<{ role: string; content: string }>): Promise<{ text: string; raw?: string } | { error: string; raw?: string } | 'timeout'> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(t.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      // max_tokens generous: reasoning models (glm/minimax) spend budget on hidden
      // reasoning before emitting content — a small cap truncates the answer.
      body: JSON.stringify({ model: t.model, messages, temperature: 0, max_tokens: 2048, stream: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }
    const rawText = await res.text();
    let data: { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>; error?: unknown };
    try { data = JSON.parse(rawText) as typeof data; } catch { return { error: `JSON parse error`, raw: rawText.slice(0, 200) }; }
    const msg = data.choices?.[0]?.message;
    const flatten = (content: unknown): string =>
      typeof content === 'string' ? content
        : Array.isArray(content) ? content.map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : '')).join(' ')
        : '';
    // Reasoning models (glm/minimax) may surface the answer only in reasoning_content.
    const text = `${flatten(msg?.content)} ${flatten(msg?.reasoning_content)}`.trim();
    return { text, raw: (text || '<empty content+reasoning>').slice(0, 120) };
  } catch (err) {
    if (ctrl.signal.aborted) return 'timeout';
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function runArm(t: ModelTarget, key: string | undefined, arm: Arm): Promise<ArmResult> {
  const outcomes: CallOutcome[] = [];
  const rawResponses: (string | undefined)[] = [];
  for (let i = 0; i < REPEATS; i++) {
    if (!key) { outcomes.push('no-key'); rawResponses.push(undefined); continue; }
    const code = sentinel(t.id, arm, i);
    const r = await callModel(t, key, buildMessages(arm, code));
    if (r === 'timeout') { outcomes.push('timeout'); rawResponses.push('timeout'); }
    else if ('error' in r) { outcomes.push('error'); rawResponses.push(r.raw ?? r.error?.slice(0, 80)); }
    else {
      const verdict = r.text.includes(code) ? 'recalled' : 'missed';
      outcomes.push(verdict);
      rawResponses.push(r.raw);
    }
  }
  const recalls = outcomes.filter((o) => o === 'recalled').length;
  const valid = outcomes.filter((o) => o === 'recalled' || o === 'missed').length;
  return { arm, outcomes, rawResponses, recalls, valid };
}

function decideSeam(system: ArmResult, firstTurn: ArmResult): ModelResult['seam'] {
  if (system.valid === 0 && firstTurn.valid === 0) return 'skipped';
  // Need the system arm to have produced verdicts to trust it.
  if (system.valid === 0) return 'inconclusive';
  const sysRate = system.recalls / Math.max(1, system.valid);
  const userRate = firstTurn.valid > 0 ? firstTurn.recalls / firstTurn.valid : 1;
  // System honored if it recalls at majority AND within 0.34 of the user-turn baseline.
  if (sysRate >= 0.5 && sysRate >= userRate - 0.34) return 'system';
  return 'first-turn';
}

async function main(): Promise<void> {
  const results: ModelResult[] = [];
  // Run models in parallel; arms within a model are sequential (cheap, ordered evidence).
  await Promise.all(
    TARGETS.map(async (t) => {
      const key = process.env[t.keyEnv];
      const system = await runArm(t, key, 'system');
      const firstTurn = await runArm(t, key, 'first-turn');
      results.push({ id: t.id, label: t.label, system, firstTurn, seam: decideSeam(system, firstTurn) });
    }),
  );
  results.sort((a, b) => a.id.localeCompare(b.id));

  const lines: string[] = [];
  lines.push('# Handoff Seam Probe — Results');
  lines.push('');
  lines.push('Per-model system-prompt-vs-first-turn sentinel recall. Drives the injection-seam');
  lines.push('routing constant for the warm handoff distiller. Generated by');
  lines.push('`scripts/experiments/handoff-seam-probe.ts` (synthetic nonce only; no real data).');
  lines.push('');
  lines.push(`Repeats per arm: ${REPEATS} · call timeout: ${CALL_TIMEOUT_MS}ms`);
  lines.push('');
  lines.push('| Model | system recall | first-turn recall | seam | system outcomes | first-turn outcomes |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    const sr = `${r.system.recalls}/${r.system.valid || 0}`;
    const ur = `${r.firstTurn.recalls}/${r.firstTurn.valid || 0}`;
    lines.push(`| ${r.label} | ${sr} | ${ur} | **${r.seam}** | ${r.system.outcomes.join(',')} | ${r.firstTurn.outcomes.join(',')} |`);
  }
  lines.push('');
  lines.push('## Evidence (raw response snippets)');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.label}`);
    lines.push('');
    lines.push('**system arm**');
    r.system.rawResponses.forEach((raw, i) => {
      lines.push(`- call ${i} (${r.system.outcomes[i]}): \`${raw ?? 'no-key'}\``);
    });
    lines.push('');
    lines.push('**first-turn arm**');
    r.firstTurn.rawResponses.forEach((raw, i) => {
      lines.push(`- call ${i} (${r.firstTurn.outcomes[i]}): \`${raw ?? 'no-key'}\``);
    });
    lines.push('');
  }
  const report = lines.join('\n');
  // Print to stdout; the caller redirects/saves to docs/experiments/handoff-seam-results.md.
  process.stdout.write(report + '\n');
}

void main();
