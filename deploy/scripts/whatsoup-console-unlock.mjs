// Console auto-unlock via CDP. Prints ONE status line; exits 0 ONLY on
// "already-valid" or "unlocked" — every other outcome exits 1 (review finding #1).
// Token source, keychain first as before: a token the wrapper handed over in
// WHATSOUP_CONSOLE_TOKEN (its login keychain read); otherwise the private
// fleet-token file, read here by descriptor (WHATSOUP_FLEET_TOKEN_FILE, default
// ~/.config/whatsoup/fleet-tokens.json), so that token passes through no
// environment. Marker read by the wrapper: reads-fleet-token-file
// The token crosses CDP only as a Runtime.callFunctionOn structured argument,
// never in argv or evaluatable JS source (finding #2). The helper uses only a
// tab on the exact fleet origin and FLEET path, or opens and navigates a new
// one; it re-checks the tab before each credential-bearing step, and the
// unlock call itself compares the page's origin before it sends (finding #3).
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
// accepted on any host. Plain http only on loopback: elsewhere the root token
// would cross the network unencrypted, which the fleet server itself refuses
// to serve without an explicit override (FLEET_BIND_ADDRESS in
// docs/configuration.md).
const LOOPBACK_HOST_RE = /^(localhost\.?|127(\.[0-9]{1,3}){3}|\[::1\])$/;

function parseFleetUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { refusal: "invalid-fleet-url" };
  }
  if (url.protocol === "http:" && !LOOPBACK_HOST_RE.test(url.hostname)) return { refusal: "insecure-fleet-url" };
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

const UNLOCK_OUTCOME_RE = /^(unlocked|origin-mismatch|unlock-exc|unlock-failed:[0-9]{3})$/;
const SAFE_ERROR_RE = /^(ws-connect|no-window-object|cdp-timeout:[A-Za-z.]+|fetch failed)$/;

const cdpPort = parseCdpPort(PORT);
if (cdpPort === null) fail("invalid-cdp-port");
const fleet = parseFleetUrl(FLEET);
if (fleet.refusal) fail(fleet.refusal);
const CDP = `http://localhost:${cdpPort}`;

const FLEET_TOKEN_RE = /^[0-9a-f]{64}$/;
// The server writes an active token, at most 4 accepted tokens and a timestamp
// (src/fleet/token-storage.ts), under 1 KiB; 64 KiB leaves room for hand-edited
// extra keys and still bounds the read.
const MAX_FLEET_TOKEN_FILE_BYTES = 64 * 1024;

// A refusal carries one fixed reason; it never names the path or the content.
class FleetTokenRefusal extends Error {}
const refuseFleetToken = (reason) => { throw new FleetTokenRefusal(reason); };

// The earlier wrapper refused group or other permission bits, so 0600 and 0400
// both pass. Each added rule blocks an exposure or a hang: a symlink at the
// leaf, a FIFO or folder in place of the file, another owner. The folder is not
// checked: the descriptor checks below bind the read to the file itself.
function assertUsableTokenFile(stat, uid) {
  if (stat.isSymbolicLink()) refuseFleetToken("symlink");
  if (!stat.isFile()) refuseFleetToken("not-a-file");
  if (stat.uid !== uid) refuseFleetToken("owner");
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
// src/fleet/token-storage.ts from a release checkout. It opens the file once
// without following a leaf symlink, checks the opened descriptor against the
// checked path by device and inode, and never creates, migrates or writes a
// token.
function readFleetConsoleToken() {
  const uid = process.getuid?.();
  if (uid === undefined || typeof constants.O_NOFOLLOW !== "number") refuseFleetToken("unsupported");
  const filePath = process.env.WHATSOUP_FLEET_TOKEN_FILE || join(homedir(), ".config", "whatsoup", "fleet-tokens.json");
  const before = lstatSync(filePath);
  assertUsableTokenFile(before, uid);
  // O_NONBLOCK: a FIFO swapped in after the lstat cannot block the open.
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    assertUsableTokenFile(opened, uid);
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
  // Wait until the LIVE document is on the fleet origin and FLEET path AND complete —
  // target.url can report the requested URL before the navigation commits (about:blank race).
  const livePath = fleet.pathname === "/"
    ? "true"
    : `(location.pathname === ${JSON.stringify(fleet.pathname)} || location.pathname.startsWith(${JSON.stringify(`${fleet.pathname}/`)}))`;
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
    if (!current || !matchesFleetTarget(current.url, fleet)) return false;
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
    // In one call the page compares its own origin with the fleet origin and
    // only then sends, so a navigation after the check above cannot receive
    // the token. The endpoint is absolute and same-origin, so a <base> element
    // or a cross-origin redirect cannot move the request. Page error text is
    // never returned or printed.
    const win = (await send("Runtime.evaluate", { expression: "window" }))?.result?.result;
    if (!win?.objectId) throw new Error("no-window-object");
    const r = (await send("Runtime.callFunctionOn", {
      objectId: win.objectId,
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
