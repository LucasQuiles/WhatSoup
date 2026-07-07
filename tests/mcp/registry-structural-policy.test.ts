/**
 * ToolRegistry structural policy: durability-containment invariant (QR-239).
 *
 * DurabilityEngine's tool-call methods (recordToolCall/markToolExecuting/
 * markToolComplete) are raw synchronous node:sqlite .run() calls with no
 * internal error handling. Inside call(), EVERY site that dereferences
 * this.durability to invoke one of these methods must sit inside an open
 * try/catch — a throw there (SQLITE_BUSY, SQLITE_FULL) must degrade to "no
 * telemetry recorded", never abort the tool call or its reply. The main-path
 * writes were wrapped; the deny-path forensic writes (recording a denied
 * sensitive-tool attempt) were not — a throwing durability write there would
 * have escaped call() entirely instead of degrading gracefully.
 *
 * This test pins BOTH the exact count of call sites (so a newly-added site
 * cannot silently evade the check by not being enumerated) and the
 * enclosure invariant for every one of them, read directly from source
 * rather than re-derived from behavior, so it fails the moment a new
 * unwrapped site is introduced.
 *
 * test-integrity: source-string-ok
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

async function readRegistrySource(): Promise<string> {
  return readFile(new URL('../../src/mcp/registry.ts', import.meta.url), 'utf8');
}

/**
 * Isolate the body of ToolRegistry.call(). Mirrors the
 * runtime-structural-policy idiom: a non-greedy capture up to the first
 * closing brace indented exactly two spaces (the method's own close),
 * immediately followed by the class's own closing brace — reliable because
 * every nested block inside the method body is indented four spaces or
 * more.
 */
function extractCallMethodBody(source: string): string {
  const match = source.match(
    /async call\([\s\S]*?\): Promise<ToolCallResult> \{([\s\S]*?)\n  \}\n\}/,
  );
  if (!match) {
    throw new Error('Could not isolate ToolRegistry.call() method body from source');
  }
  return match[1];
}

/**
 * Every call site that dereferences `this.durability` to invoke a method,
 * whether written as `this.durability.foo(` (compiler can prove non-null in
 * scope) or `this.durability!.foo(` (non-null-asserted once `durabilityId`
 * is known defined). Both are equally "a call that can throw and must be
 * guarded" — the `!` is a typing detail, not a difference in run-time risk,
 * so a fresh unwrapped site added with either spelling must trip this test.
 */
function findDurabilityCallSites(body: string): RegExpMatchArray[] {
  return [...body.matchAll(/this\.durability!?\.\w+\(/g)];
}

describe('ToolRegistry structural policy: durability containment (QR-239)', () => {
  it('pins the exact count of this.durability call sites inside call()', async () => {
    const body = extractCallMethodBody(await readRegistrySource());
    const sites = findDurabilityCallSites(body);
    // deny path: recordToolCall, markToolExecuting, markToolComplete (3)
    // main path: recordToolCall, markToolExecuting, markToolComplete(success),
    //            markToolComplete(error) (4)
    // = 7 total. A new site changes this count and forces a conscious look
    // at whether it needs the same try/catch containment.
    expect(sites.length).toBe(7);
  });

  it('every this.durability call site inside call() sits inside an open try/catch', async () => {
    const body = extractCallMethodBody(await readRegistrySource());
    const sites = findDurabilityCallSites(body);
    expect(sites.length).toBeGreaterThan(0);

    // For each site, walk backward through the method body text to the
    // nearest preceding `try {` and nearest preceding `} catch`. The site is
    // enclosed iff a try was opened and nothing has closed it since — i.e.
    // the nearest `try {` is textually closer than the nearest `} catch`.
    // This assumes no durability call site is ever placed inside an outer
    // try AFTER a sibling nested try/catch has already closed (which would
    // make the nearest preceding try look "closed" even though an outer one
    // is still open) — true for call()'s current structure, not proven in
    // general.
    const unenclosed = sites
      .map((m) => {
        const index = m.index ?? -1;
        const before = body.slice(0, index);
        const lastTry = before.lastIndexOf('try {');
        const lastCatch = before.lastIndexOf('} catch');
        return { site: m[0], index, lastTry, lastCatch, enclosed: lastTry >= 0 && lastTry > lastCatch };
      })
      .filter((r) => !r.enclosed);

    expect(unenclosed).toEqual([]);
  });
});
