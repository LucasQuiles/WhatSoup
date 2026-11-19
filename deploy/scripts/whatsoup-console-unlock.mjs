// Console auto-unlock via CDP. Prints ONE status line; exits 0 ONLY on
// "already-valid" or "unlocked" — every other outcome exits 1 (review finding #1).
// The root token is read here from the private fleet-token file and crosses
// CDP only as a Runtime.callFunctionOn structured argument, never in argv, the
// environment or evaluatable JS source (finding #2). Only fleet-origin tabs
// are ever touched (finding #3). All CDP calls carry timeouts (finding #4).
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PORT  = process.env.CDP_PORT || "9333";
const FLEET = process.env.FLEET || "http://localhost:9227";
const fail = (msg) => { console.log(msg); process.exit(1); };

const FLEET_TOKEN_RE = /^[0-9a-f]{64}$/;
const MAX_FLEET_TOKEN_FILE_BYTES = 4096;

function rejectFleetToken() {
  throw new Error("fleet-token-invalid");
}

// Folder and file must belong to this uid and neither may be a symlink. The
// folder may not be open to group or others; the file must be exactly 0600.
function assertPrivateTokenDirectory(stat, uid) {
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) rejectFleetToken();
}

function assertPrivateTokenFile(stat, uid) {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600) rejectFleetToken();
}

function assertSameIdentity(before, after) {
  if (before.dev !== after.dev || before.ino !== after.ino) rejectFleetToken();
}

function readBoundedUtf8(fd) {
  const buffer = Buffer.alloc(MAX_FLEET_TOKEN_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset > MAX_FLEET_TOKEN_FILE_BYTES) rejectFleetToken();
  return buffer.subarray(0, offset).toString("utf8");
}

// This helper is installed on its own in ~/.local/bin, so it cannot import
// src/fleet/token-storage.ts from a release checkout. It keeps that module's
// no-symlink rule, adds owner-only checks on the folder and the file, checks
// both again after opening the file without following links, and never
// creates, migrates or writes a token.
function readFleetConsoleToken() {
  const uid = process.getuid?.();
  if (uid === undefined || typeof constants.O_NOFOLLOW !== "number") rejectFleetToken();
  const filePath = process.env.WHATSOUP_FLEET_TOKEN_FILE || join(homedir(), ".config", "whatsoup", "fleet-tokens.json");
  const directory = dirname(filePath);
  const directoryBefore = lstatSync(directory);
  assertPrivateTokenDirectory(directoryBefore, uid);
  const fileBefore = lstatSync(filePath);
  assertPrivateTokenFile(fileBefore, uid);
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    assertPrivateTokenFile(opened, uid);
    assertSameIdentity(fileBefore, opened);
    const directoryAfter = lstatSync(directory);
    assertPrivateTokenDirectory(directoryAfter, uid);
    assertSameIdentity(directoryBefore, directoryAfter);
    const parsed = JSON.parse(readBoundedUtf8(fd));
    if (typeof parsed?.active !== "string" || !FLEET_TOKEN_RE.test(parsed.active)) rejectFleetToken();
    return parsed.active;
  } finally {
    closeSync(fd);
  }
}

let TOKEN = "";
try {
  TOKEN = readFleetConsoleToken();
} catch {
  fail("no-fleet-token");
}
const watchdog = setTimeout(() => fail("timeout"), 45000);

let ws;
try {
  const j = async (u, o) => (await fetch(u, o)).json();
  // Target selection: ONLY page tabs already on the fleet origin — never
  // repurpose an unrelated tab. If none, open a dedicated fleet tab.
  const targets = await j(`http://localhost:${PORT}/json`);
  // Skip fleet tabs already attached by another CDP client (no wsUrl) — fall back to a new tab.
  let page = targets.find(t => t.type === "page" && (t.url || "").startsWith(FLEET) && t.webSocketDebuggerUrl);
  if (!page) {
    const mk = `http://localhost:${PORT}/json/new?${encodeURIComponent(FLEET + "/")}`;
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
  // Navigate only if the tab isn't already on the fleet origin (preserves SPA state).
  if (!(page.url || "").startsWith(FLEET)) await send("Page.navigate", { url: FLEET + "/" });
  // Wait until the LIVE document is on the fleet origin AND complete — target.url can
  // report the requested URL before the navigation commits (about:blank race).
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const rs = await ev(`location.href.startsWith(${JSON.stringify(FLEET)}) && document.readyState === "complete"`);
    if (rs.val === true) { ready = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!ready) fail("page-not-ready");

  // 1. already valid? (no secret involved)
  const chk = await ev('fetch("/api/auth-ticket",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({audience:"api"})}).then(function(r){return r.ok?"valid":"locked"}).catch(function(){return "neterr"})', true);
  let outcome;
  if (chk.val === "valid") outcome = "already-valid";
  else {
    // 2. unlock — token passed as a structured argument, not as source text.
    const win = (await send("Runtime.evaluate", { expression: "window" }))?.result?.result;
    if (!win?.objectId) throw new Error("no-window-object");
    const r = (await send("Runtime.callFunctionOn", {
      objectId: win.objectId,
      functionDeclaration: 'function(tok){return fetch("/api/console-session",{method:"POST",headers:{"Authorization":"Bearer "+tok},credentials:"same-origin"}).then(function(r){return r.ok?"unlocked":("unlock-failed:"+r.status)}).catch(function(e){return "unlock-exc:"+String(e)})}',
      arguments: [{ value: TOKEN }],
      awaitPromise: true,
      returnByValue: true,
    }))?.result;
    if (r?.exceptionDetails) outcome = "err:" + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "?").slice(0, 120);
    else outcome = r?.result?.value || "err:empty-cdp-result";
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
  fail("err:" + String(e?.message || e).slice(0, 160));
}
