// The mailbox: one SQLite Durable Object holds every job, report, session, message and check-in.
// One instance ("main") serves the whole bridge, so reads and claims never disagree.
// Live Code windows hold a WebSocket here. The socket hibernates while idle, so it costs nothing.
import { DurableObject } from "cloudflare:workers";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  title: string;
  instructions: string;
  workspace: string;
  status: JobStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: string | null;
}

// A session is one Claude Code conversation that Duet can talk to.
//   live      a window the user opened with mac/duet-code; it hears Duet at once over its WebSocket
//   headless  a background `claude -p` conversation the Mac runs, one turn per batch of messages
export type SessionKind = "live" | "headless";
export type SessionMode = "read" | "work";

export interface Session {
  id: string;
  kind: SessionKind;
  name: string;
  workspace: string;
  mode: SessionMode;
  focus: string;
  status: "open" | "busy" | "ended";
  claude_id: string | null;
  turns: number;
  created_at: string;
  last_seen: string;
  busy_since: string | null;
}

export interface Message {
  id: string;
  session_id: string | null;
  dir: "to_code" | "to_duet";
  body: string;
  created_at: string;
  taken_at: string | null;
  read_at: string | null;
}

export interface Command {
  id: string;
  kind: "open_on_mac";
  session_id: string;
  created_at: string;
}

export interface Report {
  id: string;
  title: string;
  body: string;
  sender: string;
  created_at: string;
  read_at: string | null;
}

// Tool results stay well under Claude Code's 25k-token cap.
export const MAX_TEXT = 60_000;
// A job or turn that runs longer than this without a finish is marked failed.
const STALE_RUNNING_MS = 2 * 60 * 60 * 1000;
// Duet may hold a call open this long while it waits for Code to answer.
export const MAX_WAIT_MS = 45_000;
// A window pings every 30 seconds. A socket silent for longer than this is a dead window's leftover.
const FRESH_MS = 90_000;
// A live session with no fresh socket for this long is ended. Long enough for a night's sleep of the Mac.
const LIVE_GONE_MS = 12 * 60 * 60 * 1000;
// Sign-in lockout: this many wrong passphrases inside the window locks sign-in.
const AUTH_FAIL_LIMIT = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

const now = () => new Date().toISOString();
const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "\n[truncated]" : s);

function newId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(3));
  const hex = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${Date.now().toString(36)}-${hex}`;
}

export class Mailbox extends DurableObject {
  private sql: SqlStorage;
  // Duet calls that are waiting for Code to answer. In memory only: a restart just ends the wait early.
  private waiters = new Set<() => void>();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    // Windows ping every 30 seconds. Cloudflare answers this itself, so the ping does not wake the mailbox.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, instructions TEXT NOT NULL,
        workspace TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
        sender TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, workspace TEXT NOT NULL,
        mode TEXT NOT NULL, focus TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, claude_id TEXT,
        turns INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_seen TEXT NOT NULL, busy_since TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT, dir TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL, taken_at TEXT, read_at TEXT);
      CREATE INDEX IF NOT EXISTS messages_open ON messages (dir, session_id, taken_at, read_at);
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL,
        created_at TEXT NOT NULL, taken_at TEXT);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_fail (at INTEGER NOT NULL);
    `);
  }

  // ---- jobs ----

  addJob(title: string, instructions: string, workspace: string): Job {
    const job: Job = {
      id: newId("job"), title: clip(title).slice(0, 200), instructions: clip(instructions),
      workspace, status: "queued", created_at: now(), started_at: null, finished_at: null, result: null,
    };
    this.sql.exec(
      "INSERT INTO jobs (id,title,instructions,workspace,status,created_at) VALUES (?,?,?,?,?,?)",
      job.id, job.title, job.instructions, job.workspace, job.status, job.created_at,
    );
    return job;
  }

  getJob(id: string): Job | null {
    return (this.sql.exec("SELECT * FROM jobs WHERE id = ?", id).toArray()[0] as unknown as Job) ?? null;
  }

  listJobs(status: JobStatus | "all", limit: number): Job[] {
    this.expireStale();
    const rows = status === "all"
      ? this.sql.exec("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", limit)
      : this.sql.exec("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?", status, limit);
    return rows.toArray() as unknown as Job[];
  }

  cancelJob(id: string): Job | null {
    this.sql.exec(
      "UPDATE jobs SET status='cancelled', finished_at=? WHERE id=? AND status='queued'", now(), id);
    return this.getJob(id);
  }

  // The Mac takes the oldest queued job. One SQL statement, so two checkers cannot take the same job.
  claimJob(host: string): Job | null {
    this.checkIn(host);
    this.expireStale();
    const row = this.sql.exec(
      `UPDATE jobs SET status='running', started_at=?
       WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1)
       RETURNING *`, now()).toArray()[0];
    return (row as unknown as Job) ?? null;
  }

  finishJob(id: string, ok: boolean, result: string): Job | null {
    this.sql.exec(
      "UPDATE jobs SET status=?, finished_at=?, result=? WHERE id=? AND status='running'",
      ok ? "done" : "failed", now(), clip(result), id);
    return this.getJob(id);
  }

  private expireStale(): void {
    const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
    this.sql.exec(
      `UPDATE jobs SET status='failed', finished_at=?, result='The Mac did not finish this job within 2 hours.'
       WHERE status='running' AND started_at < ?`, now(), cutoff);
  }

  // ---- reports ----

  addReport(title: string, body: string, sender: string): Report {
    const r: Report = {
      id: newId("rep"), title: clip(title).slice(0, 200), body: clip(body),
      sender: sender.slice(0, 60) || "claude", created_at: now(), read_at: null,
    };
    this.sql.exec(
      "INSERT INTO reports (id,title,body,sender,created_at) VALUES (?,?,?,?,?)",
      r.id, r.title, r.body, r.sender, r.created_at);
    return r;
  }

  readReports(unreadOnly: boolean, limit: number, markRead: boolean): Report[] {
    const rows = (unreadOnly
      ? this.sql.exec("SELECT * FROM reports WHERE read_at IS NULL ORDER BY created_at LIMIT ?", limit)
      : this.sql.exec("SELECT * FROM reports ORDER BY created_at DESC LIMIT ?", limit)
    ).toArray() as unknown as Report[];
    if (markRead) {
      const at = now();
      for (const r of rows) {
        if (!r.read_at) this.sql.exec("UPDATE reports SET read_at=? WHERE id=?", at, r.id);
      }
    }
    return rows;
  }

  // ---- sessions ----

  getSession(id: string): Session | null {
    return (this.sql.exec("SELECT * FROM sessions WHERE id = ?", id).toArray()[0] as unknown as Session) ?? null;
  }

  // A live window says hello. With a known id (a window opened by open_on_mac, or a reconnect), it takes over
  // that session. An ended session stays ended: the window gets a new one.
  registerLive(id: string | null, name: string, workspace: string, focus: string): Session {
    const existing = id ? this.getSession(id) : null;
    if (existing && existing.status !== "ended") {
      this.sql.exec(
        "UPDATE sessions SET kind='live', status='open', busy_since=NULL, last_seen=?, name=?, focus=? WHERE id=?",
        now(), name.slice(0, 80) || existing.name, focus.slice(0, 300) || existing.focus, existing.id);
      return this.getSession(existing.id)!;
    }
    const s: Session = {
      id: newId("ses"), kind: "live", name: name.slice(0, 80) || "Code window", workspace: workspace.slice(0, 200),
      mode: "work", focus: focus.slice(0, 300), status: "open", claude_id: null, turns: 0,
      created_at: now(), last_seen: now(), busy_since: null,
    };
    this.insertSession(s);
    return s;
  }

  startHeadless(name: string, workspace: string, mode: SessionMode, firstMessage: string): { session: Session; message: Message } {
    const s: Session = {
      id: newId("ses"), kind: "headless", name: name.slice(0, 80) || "Duet session", workspace,
      mode, focus: "", status: "open", claude_id: crypto.randomUUID(), turns: 0,
      created_at: now(), last_seen: now(), busy_since: null,
    };
    this.insertSession(s);
    return { session: s, message: this.sendToCode(s.id, firstMessage) };
  }

  private insertSession(s: Session): void {
    this.sql.exec(
      `INSERT INTO sessions (id,kind,name,workspace,mode,focus,status,claude_id,turns,created_at,last_seen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      s.id, s.kind, s.name, s.workspace, s.mode, s.focus, s.status, s.claude_id, s.turns, s.created_at, s.last_seen);
  }

  setFocus(id: string, focus: string): Session | null {
    this.sql.exec("UPDATE sessions SET focus=?, last_seen=? WHERE id=?", focus.slice(0, 300), now(), id);
    return this.getSession(id);
  }

  endSession(id: string): Session | null {
    this.sql.exec("UPDATE sessions SET status='ended' WHERE id=?", id);
    // Undelivered messages to an ended session would never be read.
    this.sql.exec("UPDATE messages SET taken_at=? WHERE session_id=? AND dir='to_code' AND taken_at IS NULL", now(), id);
    for (const ws of this.ctx.getWebSockets(id)) {
      try { ws.close(1000, "session ended"); } catch { /* already closed */ }
    }
    return this.getSession(id);
  }

  // `connected` is the truth for a live window: it is true only while a socket is open and still pinging.
  listSessions(includeEnded: boolean, limit: number) {
    this.expireBusy();
    // A window that crashed never says goodbye. A fresh socket keeps last_seen current; with none for 12 hours, end it.
    const goneBefore = new Date(Date.now() - LIVE_GONE_MS).toISOString();
    for (const r of this.sql.exec("SELECT id, last_seen FROM sessions WHERE kind='live' AND status!='ended'").toArray()) {
      const id = String(r.id);
      if (this.freshSockets(id).length) this.sql.exec("UPDATE sessions SET last_seen=? WHERE id=?", now(), id);
      else if (String(r.last_seen) < goneBefore) this.endSession(id);
    }
    const rows = (includeEnded
      ? this.sql.exec("SELECT * FROM sessions ORDER BY last_seen DESC LIMIT ?", limit)
      : this.sql.exec("SELECT * FROM sessions WHERE status != 'ended' ORDER BY last_seen DESC LIMIT ?", limit)
    ).toArray() as unknown as Session[];
    return rows.map((s) => ({
      ...s,
      connected: s.kind === "live" ? this.freshSockets(s.id).length > 0 : null,
      waiting_for_code: Number(this.sql.exec(
        "SELECT COUNT(*) AS n FROM messages WHERE session_id=? AND dir='to_code' AND taken_at IS NULL", s.id).one().n),
    }));
  }

  // ---- messages ----

  sendToCode(sessionId: string, body: string): Message {
    const m = this.insertMessage(sessionId, "to_code", body);
    this.sql.exec("UPDATE sessions SET last_seen=? WHERE id=?", now(), sessionId);
    this.pushToWindow(sessionId);
    return m;
  }

  sendToDuet(sessionId: string | null, body: string): Message {
    const m = this.insertMessage(sessionId, "to_duet", body);
    if (sessionId) this.sql.exec("UPDATE sessions SET last_seen=? WHERE id=?", now(), sessionId);
    for (const wake of [...this.waiters]) wake();
    return m;
  }

  private insertMessage(sessionId: string | null, dir: Message["dir"], body: string): Message {
    const m: Message = {
      id: newId("msg"), session_id: sessionId, dir, body: clip(body), created_at: now(), taken_at: null, read_at: null,
    };
    this.sql.exec(
      "INSERT INTO messages (id,session_id,dir,body,created_at) VALUES (?,?,?,?,?)",
      m.id, m.session_id, m.dir, m.body, m.created_at);
    return m;
  }

  // Messages from Code to Duet. sessionId null means every session plus the general inbox.
  readForDuet(sessionId: string | null, markRead: boolean, limit: number): Message[] {
    const rows = (sessionId
      ? this.sql.exec("SELECT * FROM messages WHERE dir='to_duet' AND read_at IS NULL AND session_id=? ORDER BY created_at LIMIT ?", sessionId, limit)
      : this.sql.exec("SELECT * FROM messages WHERE dir='to_duet' AND read_at IS NULL ORDER BY created_at LIMIT ?", limit)
    ).toArray() as unknown as Message[];
    if (markRead) {
      const at = now();
      for (const m of rows) this.sql.exec("UPDATE messages SET read_at=? WHERE id=?", at, m.id);
    }
    return rows;
  }

  // Hold Duet's call until Code answers or the time runs out, then read.
  async waitForDuet(sessionId: string | null, ms: number, markRead: boolean, limit: number): Promise<Message[]> {
    const deadline = Date.now() + Math.min(Math.max(ms, 0), MAX_WAIT_MS);
    for (;;) {
      const rows = this.readForDuet(sessionId, markRead, limit);
      const left = deadline - Date.now();
      if (rows.length || left <= 0) return rows;
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, left);
        this.waiters.add(wake);
      });
    }
  }

  // ---- headless turns (the Mac runs these) ----

  // The oldest session with unanswered messages that is not already running. One statement, so no double claim.
  claimTurn(host: string): { session: Session; messages: Message[] } | null {
    this.checkIn(host);
    this.expireBusy();
    const row = this.sql.exec(
      `UPDATE sessions SET status='busy', busy_since=?, last_seen=?
       WHERE id = (
         SELECT s.id FROM sessions s JOIN messages m ON m.session_id = s.id
         WHERE s.kind='headless' AND s.status='open' AND m.dir='to_code' AND m.taken_at IS NULL
         ORDER BY m.created_at LIMIT 1)
       RETURNING *`, now(), now()).toArray()[0] as unknown as Session | undefined;
    if (!row) return null;
    const messages = this.sql.exec(
      "UPDATE messages SET taken_at=? WHERE session_id=? AND dir='to_code' AND taken_at IS NULL RETURNING *",
      now(), row.id).toArray() as unknown as Message[];
    messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { session: row, messages };
  }

  // ok=false still counts the turn when the Mac says the conversation exists (started), so the next turn resumes it.
  finishTurn(sessionId: string, ok: boolean, reply: string, started: boolean): Session | null {
    const s = this.getSession(sessionId);
    // Busy, or ended by Duet while the turn ran: the answer still goes back. Anything else is a repeat finish.
    if (!s || !s.busy_since) return s;
    this.sql.exec(
      `UPDATE sessions SET status=CASE WHEN status='ended' THEN 'ended' ELSE 'open' END,
       busy_since=NULL, turns=turns+?, last_seen=? WHERE id=?`,
      ok || started ? 1 : 0, now(), sessionId);
    this.sendToDuet(sessionId, ok ? reply : `Claude Code could not finish this turn. ${reply}`);
    return this.getSession(sessionId);
  }

  private expireBusy(): void {
    const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
    const stuck = this.sql.exec(
      "UPDATE sessions SET status='open', busy_since=NULL WHERE status='busy' AND busy_since < ? RETURNING id", cutoff).toArray();
    for (const r of stuck) this.sendToDuet(String(r.id), "The Mac did not finish this turn within 2 hours.");
  }

  // ---- commands for the Mac ----

  addCommand(kind: Command["kind"], sessionId: string): Command {
    const c: Command = { id: newId("cmd"), kind, session_id: sessionId, created_at: now() };
    this.sql.exec("INSERT INTO commands (id,kind,session_id,created_at) VALUES (?,?,?,?)", c.id, c.kind, c.session_id, c.created_at);
    return c;
  }

  claimCommand(): (Command & { session: Session | null }) | null {
    const row = this.sql.exec(
      `UPDATE commands SET taken_at=? WHERE id = (SELECT id FROM commands WHERE taken_at IS NULL ORDER BY created_at LIMIT 1)
       RETURNING id, kind, session_id, created_at`, now()).toArray()[0] as unknown as Command | undefined;
    return row ? { ...row, session: this.getSession(row.session_id) } : null;
  }

  // ---- live windows (WebSocket) ----

  // The Worker checks the bearer token before it forwards the upgrade here.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    const sessionId = new URL(request.url).searchParams.get("session") ?? "";
    const s = this.getSession(sessionId);
    if (!s || s.kind !== "live" || s.status === "ended") return new Response("no such live session", { status: 404 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [sessionId]);
    pair[1].serializeAttachment({ heard: Date.now() });
    this.sql.exec("UPDATE sessions SET last_seen=? WHERE id=?", now(), sessionId);
    this.pushToWindow(sessionId, pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // The sockets that heard from their window in the last 90 seconds. Cloudflare answers the pings without waking
  // the mailbox, so the last ping time comes from Cloudflare; the last real frame comes from the attachment.
  // A silent socket is closed, so a dead window stops counting as connected.
  private freshSockets(tag?: string): WebSocket[] {
    const fresh: WebSocket[] = [];
    for (const ws of tag ? this.ctx.getWebSockets(tag) : this.ctx.getWebSockets()) {
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const heard = Number((ws.deserializeAttachment() as { heard?: number } | null)?.heard ?? 0);
      if (Date.now() - Math.max(pinged, heard) < FRESH_MS) fresh.push(ws);
      else try { ws.close(1000, "silent too long"); } catch { /* already closed */ }
    }
    return fresh;
  }

  // Send every undelivered message. The window acks each one; anything not acked is sent again on reconnect.
  private pushToWindow(sessionId: string, only?: WebSocket): void {
    const sockets = only ? [only] : this.freshSockets(sessionId);
    if (!sockets.length) return;
    const rows = this.sql.exec(
      "SELECT id, body, created_at FROM messages WHERE session_id=? AND dir='to_code' AND taken_at IS NULL ORDER BY created_at",
      sessionId).toArray();
    for (const r of rows) {
      const frame = JSON.stringify({ type: "message", id: r.id, body: r.body, created_at: r.created_at });
      for (const ws of sockets) {
        try { ws.send(frame); } catch { /* a closing socket; the message stays queued */ }
      }
    }
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const [sessionId] = this.ctx.getTags(ws);
    ws.serializeAttachment({ heard: Date.now() });
    let msg: { type?: string; id?: string };
    try { msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)); } catch { return; }
    if (msg.type === "ack" && typeof msg.id === "string") {
      this.sql.exec(
        "UPDATE messages SET taken_at=? WHERE id=? AND session_id=? AND taken_at IS NULL", now(), msg.id, sessionId);
    }
    this.sql.exec("UPDATE sessions SET last_seen=? WHERE id=?", now(), sessionId);
  }

  // "window closed" is the channel's goodbye. It goes on the open line, so it arrives even when the window
  // dies before the channel can make its end call. Any other close (a network drop) keeps the session for a reconnect.
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing"); } catch { /* already closed */ }
    const [sessionId] = this.ctx.getTags(ws);
    if (reason === "window closed" && sessionId) this.endSession(sessionId);
  }

  // ---- status ----

  checkIn(host: string): void {
    this.sql.exec(
      "INSERT INTO meta (key,value) VALUES ('checkin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify({ at: now(), host: host.slice(0, 80) }));
  }

  status() {
    this.expireStale();
    const counts: Record<string, number> = {};
    for (const r of this.sql.exec("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").toArray()) {
      counts[String(r.status)] = Number(r.n);
    }
    const unread = Number(this.sql.exec("SELECT COUNT(*) AS n FROM reports WHERE read_at IS NULL").one().n);
    const unreadMessages = Number(this.sql.exec(
      "SELECT COUNT(*) AS n FROM messages WHERE dir='to_duet' AND read_at IS NULL").one().n);
    const raw = this.sql.exec("SELECT value FROM meta WHERE key='checkin'").toArray()[0];
    const checkin = raw ? JSON.parse(String(raw.value)) : null;
    return {
      jobs: counts, unread_reports: unread, unread_messages: unreadMessages,
      live_windows: this.freshSockets().length, last_mac_checkin: checkin,
    };
  }

  // ---- sign-in lockout ----

  authLocked(): boolean {
    const since = Date.now() - AUTH_WINDOW_MS;
    this.sql.exec("DELETE FROM auth_fail WHERE at < ?", since);
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM auth_fail").one().n) >= AUTH_FAIL_LIMIT;
  }

  authFailed(): void {
    this.sql.exec("INSERT INTO auth_fail (at) VALUES (?)", Date.now());
  }
}
