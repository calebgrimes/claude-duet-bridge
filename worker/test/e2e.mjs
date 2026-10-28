// End-to-end test against `wrangler dev --local-protocol https`.
// Plays Claude: registers, signs in with PKCE, calls every tool, then plays the Mac checker.
// Run: npm run dev (in another shell), then npm test.
import { createHash, randomBytes } from "node:crypto";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // wrangler dev uses a self-signed certificate
const BASE = process.env.BRIDGE_URL ?? "https://localhost:8787";
const PASS = process.env.BRIDGE_PASS ?? "dev-only-passphrase";
const TOKEN = process.env.BRIDGE_TOKEN ?? "dev-only-bridge-token";
const REDIRECT = "http://127.0.0.1:53682/callback";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✔ PASS" : "✖ FAIL"}  ${label}${ok || !detail ? "" : `  -> ${detail}`}`);
  if (!ok) failures++;
}

const b64url = (buf) => buf.toString("base64url");
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

async function authorizeUrl(clientId, redirect, challenge) {
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: "S256", state: "s1",
    scope: "mailbox", resource: `${BASE}/mcp`,
  });
  return `${BASE}/authorize?${q}`;
}

// ---- discovery ----
const unauth = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
check("unauthenticated /mcp answers 401", unauth.status === 401, String(unauth.status));
check("401 points at resource metadata", (unauth.headers.get("www-authenticate") ?? "").includes("resource_metadata"));

const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json()).catch(() => ({}));
check("protected resource metadata names /mcp", prm.resource === `${BASE}/mcp`, JSON.stringify(prm));
const asm = await fetch(`${BASE}/.well-known/oauth-authorization-server`).then((r) => r.json()).catch(() => ({}));
check("authorization server metadata has a registration endpoint", Boolean(asm.registration_endpoint));
check("authorization server advertises S256 PKCE", (asm.code_challenge_methods_supported ?? []).includes("S256"));

// ---- dynamic registration ----
const reg = await fetch(`${BASE}/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "e2e test", redirect_uris: [REDIRECT, "https://evil.example/cb"],
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  }),
}).then((r) => r.json());
check("client registers", Boolean(reg.client_id), JSON.stringify(reg));

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());

// ---- a foreign redirect is refused ----
const evil = await fetch(await authorizeUrl(reg.client_id, "https://evil.example/cb", challenge), { redirect: "manual" });
check("sign-in refuses a non-Claude redirect", evil.status === 403, String(evil.status));

// ---- consent page ----
const pageRes = await fetch(await authorizeUrl(reg.client_id, REDIRECT, challenge), { redirect: "manual" });
const html = await pageRes.text();
const cookie = cookieOf(pageRes);
const handle = (html.match(/name="handle" value="([^"]+)"/) ?? [])[1];
check("consent page renders with a handle", pageRes.status === 200 && Boolean(handle), String(pageRes.status));
check("consent page warns about a local redirect", html.includes("app on this computer"));
check("consent page blocks framing", /frame-ancestors|DENY/i.test(
  `${pageRes.headers.get("content-security-policy")} ${pageRes.headers.get("x-frame-options")}`));

const post = (fields) => fetch(`${BASE}/authorize`, {
  method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: BASE },
  body: new URLSearchParams(fields),
});

const wrong = await post({ handle, decision: "approve", passphrase: "not-it" });
check("wrong passphrase is refused", wrong.status === 401, String(wrong.status));

const right = await post({ handle, decision: "approve", passphrase: PASS });
const loc = right.headers.get("location") ?? "";
const code = new URL(loc || "http://x/").searchParams.get("code");
check("right passphrase redirects with a code", right.status === 302 && Boolean(code), `${right.status} ${loc}`);
check("redirect goes to the registered loopback", loc.startsWith(REDIRECT));

// ---- token exchange ----
const tok = await fetch(`${BASE}/token`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id,
    code_verifier: verifier, resource: `${BASE}/mcp`,
  }),
}).then((r) => r.json());
check("code exchanges for an access token", Boolean(tok.access_token), JSON.stringify(tok));
check("a refresh token is issued", Boolean(tok.refresh_token));

// ---- MCP ----
let rpcId = 0;
async function rpc(method, params = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return res.json();
}
const tool = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const t = r.result?.content?.[0]?.text ?? "";
  try { return { error: r.result?.isError, data: JSON.parse(t) }; } catch { return { error: r.result?.isError, data: t }; }
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
check("initialize echoes a supported protocol", init.result?.protocolVersion === "2025-06-18", JSON.stringify(init));
const note = await fetch(`${BASE}/mcp`, {
  method: "POST", headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
check("a notification gets 202", note.status === 202, String(note.status));

const list = await rpc("tools/list");
const names = (list.result?.tools ?? []).map((t) => t.name).sort().join(",");
check("thirteen tools are listed", names === [
  "bridge_status", "cancel_job", "end_session", "get_job", "list_jobs", "list_sessions", "open_on_mac",
  "post_report", "read_messages", "read_reports", "send_job", "send_message", "start_session"].join(","), names);

const badWs = await tool("send_job", { title: "x", instructions: "y", workspace: "nowhere" });
check("an unknown workspace is refused", badWs.error === true);

const sent = await tool("send_job", { title: "E2E job", instructions: "Say hello.", workspace: "default" });
check("send_job queues a job", sent.data?.status === "queued", JSON.stringify(sent));
const spare = await tool("send_job", { title: "To cancel", instructions: "Never runs." });
const cancelled = await tool("cancel_job", { id: spare.data.id });
check("cancel_job cancels a queued job", cancelled.data?.status === "cancelled", JSON.stringify(cancelled));

// ---- the Mac side ----
const bridge = (path, init = {}) => fetch(`${BASE}/bridge/${path}`, {
  ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "X-Bridge-Host": "e2e-mac", ...(init.headers ?? {}) },
});
const noTok = await fetch(`${BASE}/bridge/status`);
check("/bridge without a token answers 401", noTok.status === 401, String(noTok.status));
const oauthTokOnBridge = await fetch(`${BASE}/bridge/status`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
check("a connector token cannot open /bridge", oauthTokOnBridge.status === 401, String(oauthTokOnBridge.status));

const claim = await bridge("claim", { method: "POST" }).then((r) => r.json());
check("the Mac claims the queued job", claim.job?.id === sent.data.id, JSON.stringify(claim));
const claim2 = await bridge("claim", { method: "POST" }).then((r) => r.json());
check("a second claim finds nothing (cancelled job is skipped)", claim2.job === null, JSON.stringify(claim2));

const fin = await bridge(`jobs/${sent.data.id}/finish`, { method: "POST", body: JSON.stringify({ ok: true, result: "Hello from the Mac." }) }).then((r) => r.json());
check("the Mac finishes the job", fin.job?.status === "done", JSON.stringify(fin));

const got = await tool("get_job", { id: sent.data.id });
check("get_job returns the Mac's answer", got.data?.result === "Hello from the Mac.", JSON.stringify(got));

await bridge("reports", { method: "POST", body: JSON.stringify({ title: "From the Mac", body: "Report body." }) });
await tool("post_report", { title: "From a Claude window", body: "Second report.", sender: "claude-code" });
const reports = await tool("read_reports");
check("read_reports returns both reports", Array.isArray(reports.data) && reports.data.length === 2, JSON.stringify(reports));
const again = await tool("read_reports");
check("reports are marked read", again.data === "No reports.", JSON.stringify(again));

const status = await tool("bridge_status");
check("bridge_status shows the Mac check-in", status.data?.last_mac_checkin?.host === "e2e-mac", JSON.stringify(status));

// ---- sessions: a headless conversation ----
const work = (body = {}) => bridge("work", { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const badMode = await tool("start_session", { name: "x", message: "y", mode: "everything" });
check("an unknown mode is refused", badMode.error === true);
const started = await tool("start_session", { name: "E2E chat", message: "First question.", workspace: "default" });
const sid = started.data?.session?.id;
check("start_session opens a headless read session",
  started.data?.session?.kind === "headless" && started.data?.session?.mode === "read" && !("claude_id" in started.data.session),
  JSON.stringify(started));

const t1 = await work();
check("the Mac claims the first turn with its message",
  t1.turn?.session?.id === sid && t1.turn.messages.length === 1 && t1.turn.messages[0].body === "First question." && Boolean(t1.turn.session.claude_id),
  JSON.stringify(t1));
await tool("send_message", { session_id: sid, text: "Follow-up while busy." });
const t1b = await work({ jobs: false });
check("a busy session is not claimed twice", !t1b.turn, JSON.stringify(t1b));

await bridge(`turns/${sid}/finish`, { method: "POST", body: JSON.stringify({ ok: true, reply: "Answer one.", started: true }) });
const r1 = await tool("read_messages", { session_id: sid });
check("Duet reads the first answer", Array.isArray(r1.data) && r1.data[0]?.body === "Answer one.", JSON.stringify(r1));

const t2 = await work();
check("the follow-up becomes the second turn", t2.turn?.session?.turns === 1 && t2.turn.messages[0]?.body === "Follow-up while busy.", JSON.stringify(t2));
const t0 = Date.now();
const waiting = tool("read_messages", { session_id: sid, wait_seconds: 10 });
await sleep(800);
await bridge(`turns/${sid}/finish`, { method: "POST", body: JSON.stringify({ ok: true, reply: "Answer two.", started: true }) });
const r2 = await waiting;
check("a waiting read returns as soon as Code answers",
  r2.data?.[0]?.body === "Answer two." && Date.now() - t0 < 5000, `${Date.now() - t0}ms ${JSON.stringify(r2)}`);

// ---- sessions: a live window ----
const wsUrl = (id) => `${BASE.replace(/^http/, "ws")}/bridge/ws?session=${id}`;
function openWindow(id, token = TOKEN) {
  const frames = [];
  const ws = new WebSocket(wsUrl(id), { headers: { Authorization: `Bearer ${token}` } });
  const ready = new Promise((resolve) => { ws.onopen = () => resolve(true); ws.onerror = () => resolve(false); });
  ws.onmessage = (ev) => {
    const f = JSON.parse(String(ev.data));
    frames.push(f);
    ws.send(JSON.stringify({ type: "ack", id: f.id }));
  };
  return { ws, ready, frames };
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await sleep(50); return fn(); };

const live = await bridge("sessions/live", { method: "POST", body: JSON.stringify({ name: "E2E window", workspace: "/tmp", focus: "testing" }) }).then((r) => r.json());
const lid = live.session?.id;
check("a live window registers", live.session?.kind === "live", JSON.stringify(live));
const intruder = openWindow(lid, "wrong-token");
check("a socket without the token is refused", (await intruder.ready) === false);

const win = openWindow(lid);
check("the window's socket opens", await win.ready);
const listed = await tool("list_sessions");
check("list_sessions shows the window as connected",
  Array.isArray(listed.data) && listed.data.some((s) => s.id === lid && s.connected === true), JSON.stringify(listed));
const tLive = Date.now();
await tool("send_message", { session_id: lid, text: "Hello, window." });
check("the window hears Duet within seconds", await until(() => win.frames.some((f) => f.body === "Hello, window.")), `${Date.now() - tLive}ms`);

await bridge(`sessions/${lid}/messages`, { method: "POST", body: JSON.stringify({ body: "Hello, Duet." }) });
const fromWin = await tool("read_messages", { session_id: lid });
check("Duet reads the window's answer", fromWin.data?.[0]?.body === "Hello, Duet.", JSON.stringify(fromWin));

win.ws.close();
await sleep(300);
await tool("send_message", { session_id: lid, text: "Sent while closed." });
const win2 = openWindow(lid);
await win2.ready;
check("a message sent while the window was closed arrives on reconnect",
  await until(() => win2.frames.some((f) => f.body === "Sent while closed.")) && !win2.frames.some((f) => f.body === "Hello, window."),
  JSON.stringify(win2.frames));

// ---- open on the Mac, end, and messages outside a session ----
const refused = await tool("open_on_mac", { session_id: lid });
check("open_on_mac refuses a live window", refused.error === true);
await tool("send_message", { session_id: sid, text: "Queued before opening." });
const opened = await tool("open_on_mac", { session_id: sid });
check("open_on_mac queues a command", Boolean(opened.data?.queued), JSON.stringify(opened));
const cmd = await work();
check("the Mac gets the open command with the conversation id",
  cmd.command?.kind === "open_on_mac" && Boolean(cmd.command.session?.claude_id), JSON.stringify(cmd));
const afterOpen = await work({ jobs: false });
check("an opened session gets no more background turns", !afterOpen.turn, JSON.stringify(afterOpen));

const ended = await tool("end_session", { session_id: lid });
check("end_session ends the window's session", ended.data?.status === "ended", JSON.stringify(ended));
const late = await tool("send_message", { session_id: lid, text: "Too late." });
check("an ended session refuses messages", late.error === true);
win2.ws.close();

const back = await bridge("sessions/live", { method: "POST", body: JSON.stringify({ id: lid, name: "E2E window", workspace: "/tmp", focus: "" }) }).then((r) => r.json());
check("a window that comes back to an ended session gets a new one",
  Boolean(back.session?.id) && back.session.id !== lid && back.session.status === "open", JSON.stringify(back));
const bye = openWindow(back.session?.id);
await bye.ready;
bye.ws.close(1000, "window closed");
let byeGone = false;
for (let i = 0; i < 30 && !byeGone; i++) {
  await sleep(100);
  const l = await tool("list_sessions");
  byeGone = Array.isArray(l.data) && !l.data.some((s) => s.id === back.session?.id);
}
check("the channel's goodbye on the line ends the session", byeGone);

await bridge("messages", { method: "POST", body: JSON.stringify({ body: "Code says hi first." }) });
const inbox = await tool("read_messages");
check("Code can message Duet outside any session",
  Array.isArray(inbox.data) && inbox.data.some((m) => m.body === "Code says hi first." && m.session_id === null), JSON.stringify(inbox));

// ---- leave jobs for the Mac-side test (mac/duet-bridge.py poll) ----
for (const brief of (process.env.LEAVE_JOBS ?? "").split("||").filter(Boolean)) {
  const left = await tool("send_job", { title: brief.slice(0, 60), instructions: brief, workspace: "default" });
  console.log(`  left job ${left.data.id}: ${brief.slice(0, 60)}`);
}

// ---- lockout (skipped when leaving jobs, so the store stays usable for another run) ----
if (!process.env.LEAVE_JOBS) {
  for (let i = 0; i < 5; i++) await post({ handle: "x", decision: "approve", passphrase: "wrong" });
  const locked = await post({ handle: "x", decision: "approve", passphrase: PASS });
  check("sign-in locks after repeated wrong passphrases", locked.status === 429, String(locked.status));
}

console.log(failures ? `\n✖ ${failures} check(s) failed` : "\n✔ all checks passed");
process.exit(failures ? 1 : 0);
