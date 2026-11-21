// Console auto-unlock via CDP. Prints ONE status line; exits 0 ONLY on
// "already-valid" or "unlocked" — every other outcome exits 1 (review finding #1).
// Token source, keychain first as before: a token handed over in
// WHATSOUP_CONSOLE_TOKEN, used as is (the wrapper's keychain lookup; an older
// wrapper also handed over its own file read); otherwise the private
// fleet-token file, read here by descriptor (WHATSOUP_FLEET_TOKEN_FILE, default
// ~/.config/whatsoup/fleet-tokens.json), so that token passes through no
// environment. Marker read by the wrapper: reads-fleet-token-file
// The token crosses CDP only as a Runtime.callFunctionOn structured argument,
// never in argv or evaluatable JS source (finding #2). The helper uses only a
// tab on the exact fleet origin and FLEET path, or opens and navigates a new
// one; it re-checks the tab before each credential-bearing step, and the
// unlock call runs only in the document whose origin was checked (finding #3).
// All CDP calls carry timeouts (finding #4).
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT  = process.env.CDP_PORT || "9333";
const FLEET = process.env.FLEET || "http://localhost:9227";
const fail = (msg) => { console.log(msg); process.exit(1); };

function parseCdpPort(value) {
  if (!/^[0-9]{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port > 0 && port <= 65535 ? port : null;
}

// FLEET is operator configuration, as before. Its exact origin is the only place
// the token may go, and its path selects the tab: a text prefix test would also
// accept http://localhost:9227@example.invalid/ or a sibling path. https is
// accepted on any host. Plain http only on a loopback address, judged from the
// URL alone, with no name lookup: localhost, 127.0.0.0/8, [::1] and the
// IPv4-mapped form of 127.0.0.0/8 (the URL parser writes [::ffff:127.0.0.1] as
// [::ffff:7f00:1]). Any other plain-http host can put the root token on the
// network unencrypted, which the fleet server itself refuses to serve without
// an explicit override (FLEET_BIND_ADDRESS in docs/configuration.md); a host
// name for loopback is refused too, and the message names the fix.
const LOOPBACK_HOST_RE = /^(localhost\.?|127(\.[0-9]{1,3}){3}|\[::1\]|\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\])$/;
const INSECURE_FLEET_URL = "insecure-fleet-url: use https, or a loopback address";

function parseFleetUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { refusal: "invalid-fleet-url" };
  }
  if (url.protocol === "http:" && !LOOPBACK_HOST_RE.test(url.hostname)) return { refusal: INSECURE_FLEET_URL };
  if (url.protocol !== "http:" && url.protocol !== "https:") return { refusal: "invalid-fleet-url" };
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  // The tab opens the FLEET path with one trailing slash, as FLEET + "/" did;
  // a query or fragment stays on that page URL only. User-info is dropped.
  const targetPath = pathname === "/" ? "/" : `${pathname}/`;
  return { origin: url.origin, pathname, targetUrl: `${url.origin}${targetPath}${url.search}${url.hash}` };
}

function matchesFleetTarget(value, fleet) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== fleet.origin) return false;
  return fleet.pathname === "/" || url.pathname === fleet.pathname || url.pathname.startsWith(`${fleet.pathname}/`);
}

// Readiness as on main, whose test was location.href.startsWith(FLEET): a page
// whose path begins with the FLEET path text is the console, including one a
// same-origin redirect leads to (/agents to /agents-v2). Only the origin is
// exact; the token goes only to that origin. The checks before each
// credential-bearing step use the same rule for CDP's URL of the tab.
function onFleetConsole(value, fleet) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.origin === fleet.origin && url.pathname.startsWith(fleet.pathname);
}

const UNLOCK_OUTCOME_RE = /^(unlocked|origin-mismatch|unlock-exc|unlock-failed:[0-9]{3})$/;
const SAFE_ERROR_RE = /^(ws-connect|no-window-object|cdp-timeout:[A-Za-z.]+|fetch failed)$/;

const cdpPort = parseCdpPort(PORT);
if (cdpPort === null) fail("invalid-cdp-port");
const fleet = parseFleetUrl(FLEET);
if (fleet.refusal) fail(fleet.refusal);
const CDP = `http://localhost:${cdpPort}`;

const FLEET_TOKEN_RE = /^[0-9a-f]{64}$/;
// The server writes an active token, at most 4 accepted tokens and a timestamp
// (src/fleet/token-storage.ts), under 1 KiB; the earlier wrapper read any size.
// The 1 MiB bound guards against reading a wrong file (WHATSOUP_FLEET_TOKEN_FILE
// naming a log, for example); it is not a rule about tokens.
const MAX_FLEET_TOKEN_FILE_BYTES = 1024 * 1024;

// A refusal carries one fixed reason; it never names the path or the content.
class FleetTokenRefusal extends Error {}
const refuseFleetToken = (reason) => { throw new FleetTokenRefusal(reason); };

// The earlier wrapper refused group or other permission bits, so 0600 and 0400
// both pass, and it checked no owner; neither does this helper: a file it can
// read whose mode has no group or other bit is accepted. The other rules block
// a misdirected read or a hang: a symlink at the leaf, a FIFO or folder in
// place of the file. The folder is not checked: the descriptor checks below
// bind the read to the file itself.
function assertUsableTokenFile(stat) {
  if (stat.isSymbolicLink()) refuseFleetToken("symlink");
  if (!stat.isFile()) refuseFleetToken("not-a-file");
  if ((stat.mode & 0o077) !== 0) refuseFleetToken("mode");
}

function readBoundedUtf8(fd) {
  const buffer = Buffer.alloc(MAX_FLEET_TOKEN_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset > MAX_FLEET_TOKEN_FILE_BYTES) refuseFleetToken("too-large");
  return buffer.subarray(0, offset).toString("utf8");
}

// This helper is installed on its own in ~/.local/bin, so it cannot import
// src/fleet/token-storage.ts from a release checkout. Each read opens the file
// once without following a leaf symlink, checks the opened descriptor against
// the checked path by device and inode, and never creates, migrates or writes
// a token.
function readFleetTokenFileOnce(filePath) {
  const before = lstatSync(filePath);
  assertUsableTokenFile(before);
  // O_NONBLOCK: a FIFO swapped in after the lstat cannot block the open.
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    assertUsableTokenFile(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) refuseFleetToken("changed");
    const text = readBoundedUtf8(fd);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      refuseFleetToken("shape");
    }
    if (typeof parsed?.active !== "string" || !FLEET_TOKEN_RE.test(parsed.active)) refuseFleetToken("shape");
    return parsed.active;
  } finally {
    closeSync(fd);
  }
}

// The fleet server rotates the file by atomic rename
// (src/fleet/token-storage.ts), so a valid file can be replaced between the
// lstat and the open. Read once more from the start before refusing "changed".
function readFleetConsoleToken() {
  if (typeof constants.O_NOFOLLOW !== "number") refuseFleetToken("unsupported");
  const filePath = process.env.WHATSOUP_FLEET_TOKEN_FILE || join(homedir(), ".config", "whatsoup", "fleet-tokens.json");
  try {
    return readFleetTokenFileOnce(filePath);
  } catch (error) {
    if (!(error instanceof FleetTokenRefusal) || error.message !== "changed") throw error;
  }
  return readFleetTokenFileOnce(filePath);
}

// fs error messages carry the path, so only fixed reasons are printed.
function fleetTokenRefusalReason(error) {
  if (error instanceof FleetTokenRefusal) return error.message;
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "missing";
  if (error?.code === "ELOOP") return "symlink";
  return "unreadable";
}

// A handed-over token is used as is, as before: the server compares tokens
// without a shape rule. The file is read only when none was handed over.
let TOKEN = process.env.WHATSOUP_CONSOLE_TOKEN || "";
if (!TOKEN) {
  try {
    TOKEN = readFleetConsoleToken();
  } catch (error) {
    fail("no-fleet-token:" + fleetTokenRefusalReason(error));
  }
}
const watchdog = setTimeout(() => fail("timeout"), 45000);

let ws;
try {
  const j = async (u, o) => (await fetch(u, o)).json();
  // Target selection: ONLY page tabs already on the fleet target — never
  // repurpose an unrelated tab. If none, open a dedicated fleet tab.
  const targets = await j(`${CDP}/json`);
  // Skip fleet tabs already attached by another CDP client (no wsUrl) — fall back to a new tab.
  let page = targets.find(t => t.type === "page" && matchesFleetTarget(t.url, fleet) && t.webSocketDebuggerUrl);
  if (!page) {
    const mk = `${CDP}/json/new?${encodeURIComponent(fleet.targetUrl)}`;
    page = await j(mk, { method: "PUT" }).catch(() => null) || await j(mk).catch(() => null);
  }
  if (!page || !page.webSocketDebuggerUrl) fail("no-fleet-target");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws-connect")); });
  let id = 0;
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    const h = e => { const m = JSON.parse(e.data); if (m.id === mid) { clearTimeout(tm); ws.removeEventListener("message", h); res(m); } };
    const tm = setTimeout(() => { ws.removeEventListener("message", h); rej(new Error("cdp-timeout:" + method)); }, 10000);
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expression, awaitPromise = false) => {
    const r = (await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }))?.result;
    if (r?.exceptionDetails) return { err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "?").slice(0, 120) };
    return { val: r?.result?.value };
  };
  await send("Page.enable"); await send("Runtime.enable");
  // Navigate only if the tab isn't already on the fleet target (preserves SPA state).
  // A tab opened above can report about:blank or the requested URL; either way
  // the readiness check and the checks below gate the token.
  if (!matchesFleetTarget(page.url, fleet)) await send("Page.navigate", { url: fleet.targetUrl });
  // Wait until the LIVE document is on the fleet console (onFleetConsole) AND complete —
  // target.url can report the requested URL before the navigation commits (about:blank race).
  const livePath = `location.pathname.startsWith(${JSON.stringify(fleet.pathname)})`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const rs = await ev(`location.origin === ${JSON.stringify(fleet.origin)} && ${livePath} && document.readyState === "complete"`);
    if (rs.val === true) { ready = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!ready) fail("page-not-ready");

  // Right before each credential-bearing step, read CDP's current URL for this
  // tab and the live document's origin again: either may have moved since.
  const atExpectedFleetTarget = async () => {
    const current = (await j(`${CDP}/json`)).find(t => t.id === page.id);
    if (!current || !onFleetConsole(current.url, fleet)) return false;
    const live = await ev(`location.origin === ${JSON.stringify(fleet.origin)}`);
    return live.val === true;
  };
  if (!(await atExpectedFleetTarget())) fail("origin-mismatch");

  // 1. already valid? (no secret involved)
  const chk = await ev('fetch("/api/auth-ticket",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({audience:"api"})}).then(function(r){return r.ok?"valid":"locked"}).catch(function(){return "neterr"})', true);
  let outcome;
  if (chk.val === "valid") outcome = "already-valid";
  else {
    if (!(await atExpectedFleetTarget())) fail("origin-mismatch");
    // 2. unlock — token passed as a structured argument, not as source text.
    // The call that resolves the page's window object checks the page's
    // origin and carries no token. The unlock function then runs on that
    // object, which pins it to the checked document: if a navigation commits
    // in between, the object is gone and CDP refuses the call, so no other
    // document receives the token. The function compares the origin once more
    // and posts to the absolute same-origin endpoint, so a <base> element or a
    // cross-origin redirect cannot move the request. Page error text is never
    // returned or printed.
    const checked = (await send("Runtime.evaluate", {
      expression: `location.origin === ${JSON.stringify(fleet.origin)} ? window : null`,
    }))?.result;
    if (checked?.exceptionDetails || !checked?.result) throw new Error("no-window-object");
    if (!checked.result.objectId) fail("origin-mismatch");
    const r = (await send("Runtime.callFunctionOn", {
      objectId: checked.result.objectId,
      functionDeclaration: 'function(tok,origin){if(location.origin!==origin)return "origin-mismatch";return fetch(origin+"/api/console-session",{method:"POST",headers:{"Authorization":"Bearer "+tok},credentials:"same-origin",mode:"same-origin"}).then(function(r){return r.ok?"unlocked":("unlock-failed:"+r.status)}).catch(function(){return "unlock-exc"})}',
      arguments: [{ value: TOKEN }, { value: fleet.origin }],
      awaitPromise: true,
      returnByValue: true,
    }))?.result;
    const value = r?.result?.value;
    if (r?.exceptionDetails) outcome = "err:unlock-exception";
    else if (value === undefined) outcome = "err:empty-cdp-result";
    else outcome = typeof value === "string" && UNLOCK_OUTCOME_RE.test(value) ? value : "err:unexpected-unlock-result";
    // Cosmetic follow-ups must not convert a real success into a reported failure.
    if (outcome === "unlocked") { try { await send("Page.reload"); await new Promise(r2 => setTimeout(r2, 600)); } catch {} }
  }
  try { await send("Page.bringToFront"); } catch {}
  clearTimeout(watchdog);
  console.log(outcome);
  try { ws.close(); } catch {}
  // Explicit exit: never depend on event-loop drain (a wedged ws close would hang us).
  process.exit((outcome === "already-valid" || outcome === "unlocked") ? 0 : 1);
} catch (e) {
  try { ws && ws.close(); } catch {}
  // Only the helper's own messages are printed: other error text (a CDP answer
  // that is not JSON, for example) can carry browser-supplied content.
  const message = String(e?.message || e);
  fail("err:" + (SAFE_ERROR_RE.test(message) ? message : `unexpected-${e instanceof Error ? e.name : "error"}`));
}
