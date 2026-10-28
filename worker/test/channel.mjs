// Channel test against `wrangler dev`. Plays Claude Code: starts channel/channel.mjs over stdio,
// then plays Duet through the connector, and checks that each side hears the other.
// Run: npm run dev (in another shell, fresh state), then node test/channel.mjs.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const BASE = process.env.BRIDGE_URL ?? "https://localhost:8787";
const PASS = process.env.BRIDGE_PASS ?? "dev-only-passphrase";
const TOKEN = process.env.BRIDGE_TOKEN ?? "dev-only-bridge-token";
const REDIRECT = "http://127.0.0.1:53682/callback";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✔ PASS" : "✖ FAIL"}  ${label}${ok || !detail ? "" : `  -> ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!(await fn()) && Date.now() < end) await sleep(100); return fn(); };

// ---- sign in as Duet ----
const reg = await fetch(`${BASE}/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_name: "channel test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"], response_types: ["code"] }),
}).then((r) => r.json());
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT,
  code_challenge: challenge, code_challenge_method: "S256", state: "s", scope: "mailbox", resource: `${BASE}/mcp` });
const page = await fetch(`${BASE}/authorize?${q}`, { redirect: "manual" });
const handle = ((await page.text()).match(/name="handle" value="([^"]+)"/) ?? [])[1];
const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const ok = await fetch(`${BASE}/authorize`, { method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: BASE },
  body: new URLSearchParams({ handle, decision: "approve", passphrase: PASS }) });
const code = new URL(ok.headers.get("location")).searchParams.get("code");
const tok = await fetch(`${BASE}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id,
    code_verifier: verifier, resource: `${BASE}/mcp` }) }).then((r) => r.json());
let rid = 0;
const duet = async (name, args = {}) => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST",
    headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } }) }).then((x) => x.json());
  const t = r.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(t); } catch { return t; }
};
check("Duet signs in", Boolean(tok.access_token));

// ---- start the channel the way Claude Code does ----
const tokenFile = join(tmpdir(), `duet-channel-test-${process.pid}`);
writeFileSync(tokenFile, TOKEN);
const lockFile = join(tmpdir(), `duet-channel-test-${process.pid}.lock`);
const channelEnv = (name) => ({ ...process.env, DUET_BRIDGE_URL: BASE, DUET_BRIDGE_TOKEN_FILE: tokenFile,
  DUET_SESSION_NAME: name, DUET_LOCK_FILE: lockFile });
const child = spawn(process.execPath, [new URL("../../channel/channel.mjs", import.meta.url).pathname], {
  env: channelEnv("Channel test window"),
  stdio: ["pipe", "pipe", "inherit"],
});
const inbox = [];
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) inbox.push(JSON.parse(line));
  }
});
const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
const reply = async (id) => { await until(() => inbox.some((m) => m.id === id)); return inbox.find((m) => m.id === id); };

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
const init = await reply(1);
check("the channel declares claude/channel", Boolean(init?.result?.capabilities?.experimental?.["claude/channel"]), JSON.stringify(init));
check("the channel tells Code how to answer", String(init?.result?.instructions ?? "").includes("send_to_duet"));
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const tools = (await reply(2))?.result?.tools?.map((t) => t.name).sort().join(",");
check("the channel offers send_to_duet and set_focus", tools === "send_to_duet,set_focus", tools);

let win;
await until(async () => {
  const list = await duet("list_sessions");
  win = Array.isArray(list) ? list.find((s) => s.name === "Channel test window" && s.connected) : null;
  return Boolean(win);
});
check("Duet sees the window as connected", Boolean(win));

// ---- Duet to Code ----
const t0 = Date.now();
await duet("send_message", { session_id: win.id, text: "What are you working on?" });
const pushed = await until(() => inbox.some((m) => m.method === "notifications/claude/channel"));
const note = inbox.find((m) => m.method === "notifications/claude/channel");
check("Duet's message reaches the session as a channel event",
  pushed && note.params.content === "What are you working on?" && Boolean(note.params.meta.message_id), `${Date.now() - t0}ms`);

// ---- Code to Duet ----
const waiting = duet("read_messages", { session_id: win.id, wait_seconds: 10 });
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_to_duet", arguments: { text: "The channel test." } } });
check("send_to_duet succeeds", !(await reply(3))?.result?.isError);
const got = await waiting;
check("Duet gets Code's answer", Array.isArray(got) && got[0]?.body === "The channel test.", JSON.stringify(got));

send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "set_focus", arguments: { focus: "Running the channel test" } } });
await reply(4);
const focused = (await duet("list_sessions")).find((s) => s.id === win.id);
check("set_focus shows in Duet's list", focused?.focus === "Running the channel test", JSON.stringify(focused));

// ---- a background copy of the window (same settings, so the same lock) ----
const copy = spawn(process.execPath, [new URL("../../channel/channel.mjs", import.meta.url).pathname], {
  env: channelEnv("Channel test copy"), stdio: ["pipe", "pipe", "inherit"],
});
let copyOut = "";
copy.stdout.on("data", (d) => { copyOut += d; });
copy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n");
copy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
copy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_to_duet", arguments: { text: "from the copy" } } }) + "\n");
await until(() => copyOut.includes('"id":2'));
await sleep(1500);
const withCopy = await duet("list_sessions");
check("a background copy does not show up as a second window",
  Array.isArray(withCopy) && !withCopy.some((s) => s.name === "Channel test copy"), JSON.stringify(withCopy));
check("a background copy refuses to send", copyOut.includes("background copy"), copyOut);
copy.stdin.end();
await new Promise((r) => copy.on("exit", r));
const afterCopy = await duet("list_sessions");
check("a background copy closing leaves the window connected",
  Array.isArray(afterCopy) && afterCopy.some((s) => s.id === win.id && s.connected), JSON.stringify(afterCopy));

// ---- the window closes ----
child.stdin.end();
await new Promise((r) => child.on("exit", r));
const after = await duet("list_sessions");
check("closing the window ends its session", !after.some?.((s) => s.id === win.id), JSON.stringify(after));

console.log(failures ? `\n✖ ${failures} check(s) failed` : "\n✔ all channel checks passed");
process.exit(failures ? 1 : 0);
