// Console auto-unlock via CDP. Prints ONE status line; exits 0 ONLY on
// "already-valid" or "unlocked" — every other outcome exits 1 (review finding #1).
// The root token crosses CDP as a Runtime.callFunctionOn structured argument,
// never inlined in evaluatable JS source (finding #2). Only fleet-origin tabs
// are ever touched (finding #3). All CDP calls carry timeouts (finding #4).
const PORT  = process.env.CDP_PORT || "9333";
const FLEET = process.env.FLEET || "http://localhost:9227";
const TOKEN = process.env.WHATSOUP_CONSOLE_TOKEN || "";
const fail = (msg) => { console.log(msg); process.exit(1); };
if (!TOKEN) fail("no-token");
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
