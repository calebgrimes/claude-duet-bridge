// The mailbox: one SQLite Durable Object holds every job, report and check-in.
// One instance ("main") serves the whole bridge, so reads and claims never disagree.
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
// A job that runs longer than this without a finish is marked failed.
const STALE_RUNNING_MS = 2 * 60 * 60 * 1000;
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

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, instructions TEXT NOT NULL,
        workspace TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
        sender TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
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
    const raw = this.sql.exec("SELECT value FROM meta WHERE key='checkin'").toArray()[0];
    const checkin = raw ? JSON.parse(String(raw.value)) : null;
    return { jobs: counts, unread_reports: unread, last_mac_checkin: checkin };
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
