// The MCP endpoint. Stateless Streamable HTTP: every POST carries JSON-RPC and gets a JSON reply.
// No server-to-client stream, so GET and DELETE answer 405.
import type { Env } from "./index";
import type { JobStatus, Mailbox } from "./mailbox";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "duet-bridge", title: "Duet Bridge", version: "2.0.0" };

const INSTRUCTIONS = `Duet Bridge connects you to Claude Code on the user's Mac. You talk to Claude Code in sessions.
- list_sessions shows every session. A "live" session is a Code window the user has open; connected=true means it hears you within seconds. A "headless" session is a background conversation the Mac runs for you.
- To pass work to Claude Code, call start_session with a complete brief. Claude Code sees only your text, not this chat. Use mode "read" (the default) to look things up and draft answers. Use mode "work" only when the job must edit files or run commands, and only when the user asked for that.
- To continue any session, live or headless, call send_message. Give wait_seconds (up to 45) to get the answer in the same call. If it is not back yet, call read_messages later with that session_id.
- Claude Code can also message you first. Call read_messages with no session_id at the start of a conversation and on each background check, and tell the user what is there.
- open_on_mac shows a headless session in a terminal window on the Mac, so the user can take over by hand. end_session closes a session you no longer need.
- Nothing Claude Code does sends email or messages for the user. It stages drafts for the user to review.
- bridge_status shows when the Mac last checked in. If that is more than 2 minutes ago, the Mac is probably asleep or offline, so tell the user the work will wait.
- send_job, get_job, list_jobs and cancel_job are the older one-shot path. Prefer sessions.`;

const STATUSES = ["queued", "running", "done", "failed", "cancelled"];

function tools(workspaces: string[]) {
  return [
    {
      name: "send_job",
      title: "Send a job to Claude Code",
      description:
        "Queue a read-only job for Claude Code on the user's Mac. Write the instructions as a complete brief: Claude Code sees only this text. Returns a job id. The Mac picks jobs up within seconds while it is awake.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "A short name for the job, for example 'Summarize this week's meeting notes'." },
          instructions: { type: "string", description: "The full brief: what to find or draft, and what the answer should look like." },
          workspace: { type: "string", enum: workspaces, default: workspaces[0], description: "Which project folder on the Mac the job runs in." },
        },
        required: ["title", "instructions"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "get_job",
      title: "Read a job",
      description: "Read one job: its status and, when it is done, Claude Code's full answer.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The job id from send_job or list_jobs." } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "list_jobs",
      title: "List jobs",
      description: "List recent jobs, newest first, without their full answers.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: [...STATUSES, "all"], default: "all" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "cancel_job",
      title: "Cancel a job",
      description: "Cancel a job that is still queued. A job that already started cannot be cancelled.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "post_report",
      title: "Post a report",
      description:
        "Leave a report in the mailbox for the other side to read. Claude Code uses this to tell Duet about finished work; Duet can use it to leave notes for Claude Code.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string", description: "The report, in plain text or Markdown." },
          sender: { type: "string", description: "Who is writing, for example 'claude-code' or 'duet'.", default: "claude" },
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "read_reports",
      title: "Read reports",
      description: "Read reports left in the mailbox. By default returns unread reports, oldest first, and marks them read.",
      inputSchema: {
        type: "object",
        properties: {
          unread_only: { type: "boolean", default: true },
          mark_read: { type: "boolean", default: true },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "bridge_status",
      title: "Bridge status",
      description: "Job counts, unread messages and reports, open live windows, and when the Mac last checked in.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "list_sessions",
      title: "List Claude Code sessions",
      description:
        "List Claude Code sessions, newest activity first: live windows the user has open (connected=true means it hears you now) and headless sessions the Mac runs. Shows each one's name, folder, focus and status.",
      inputSchema: {
        type: "object",
        properties: { include_ended: { type: "boolean", default: false } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "start_session",
      title: "Start a Claude Code session",
      description:
        "Start a new background Claude Code conversation on the user's Mac and send it the first message. Write a complete brief: Claude Code sees only this text. Continue it later with send_message.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "A short name, for example 'Weekly review prep'." },
          message: { type: "string", description: "The full first message: what to do and what the answer should look like." },
          workspace: { type: "string", enum: workspaces, default: workspaces[0], description: "Which project folder on the Mac the session runs in." },
          mode: {
            type: "string", enum: ["read", "work"], default: "read",
            description: "read: look things up and answer in text. work: may also edit files and run commands, with the user's own Claude Code safety rules on. Use work only when the user asked for changes.",
          },
          wait_seconds: { type: "integer", minimum: 0, maximum: 45, default: 0, description: "Hold the call this long for the first answer." },
        },
        required: ["name", "message"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "send_message",
      title: "Message a Claude Code session",
      description:
        "Send a message to a Claude Code session, live or headless. A connected live window gets it within seconds. A headless session answers in its next turn. Give wait_seconds to get the answer in this call.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "The id from list_sessions or start_session." },
          text: { type: "string", description: "The message." },
          wait_seconds: { type: "integer", minimum: 0, maximum: 45, default: 0 },
        },
        required: ["session_id", "text"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "read_messages",
      title: "Read messages from Claude Code",
      description:
        "Read unread messages that Claude Code sent you, oldest first, and mark them read. Give a session_id for one session, or none for everything, including messages Claude Code sent outside any session.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          wait_seconds: { type: "integer", minimum: 0, maximum: 45, default: 0, description: "If nothing is there yet, wait this long for a message." },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "end_session",
      title: "End a session",
      description: "Close a session. A headless session stops taking turns; a live window disconnects from Duet but stays open on the Mac.",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "open_on_mac",
      title: "Open a session on the Mac",
      description:
        "Open a headless session in a terminal window on the user's Mac, so the user can read it and take over by hand. The window then becomes a live session.",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function wait(args: Record<string, unknown>): number {
  const v = args.wait_seconds;
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ToolError("'wait_seconds' must be a whole number from 0.");
  return Math.min(v, 45) * 1000;
}

// What a session looks like to Duet: no internal ids it cannot use.
const view = <T extends { claude_id?: unknown; busy_since?: unknown }>({ claude_id, busy_since, ...rest }: T) => rest;

class ToolError extends Error {}

const text = (value: unknown) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`Missing '${key}'.`);
    return "";
  }
  if (typeof v !== "string") throw new ToolError(`'${key}' must be text.`);
  return v.trim();
}

function int(args: Record<string, unknown>, key: string, dflt: number, max: number): number {
  const v = args[key];
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ToolError(`'${key}' must be a whole number from 1.`);
  return Math.min(v, max);
}

function bool(args: Record<string, unknown>, key: string, dflt: boolean): boolean {
  const v = args[key];
  return typeof v === "boolean" ? v : dflt;
}

async function callTool(env: Env, name: string, args: Record<string, unknown>) {
  const box = mailbox(env);
  const workspaces = workspaceList(env);
  switch (name) {
    case "send_job": {
      const workspace = str(args, "workspace", false) || workspaces[0];
      if (!workspaces.includes(workspace)) throw new ToolError(`Unknown workspace '${workspace}'. Use one of: ${workspaces.join(", ")}.`);
      const job = await box.addJob(str(args, "title"), str(args, "instructions"), workspace);
      const status = await box.status();
      return text({ id: job.id, status: job.status, workspace, last_mac_checkin: status.last_mac_checkin });
    }
    case "get_job": {
      const job = await box.getJob(str(args, "id"));
      if (!job) throw new ToolError("No job has that id.");
      return text(job);
    }
    case "list_jobs": {
      const status = (str(args, "status", false) || "all") as JobStatus | "all";
      if (status !== "all" && !STATUSES.includes(status)) throw new ToolError(`Unknown status '${status}'.`);
      const jobs = await box.listJobs(status, int(args, "limit", 10, 50));
      return text(jobs.map(({ result, instructions, ...rest }) => ({ ...rest, has_result: result !== null })));
    }
    case "cancel_job": {
      const job = await box.cancelJob(str(args, "id"));
      if (!job) throw new ToolError("No job has that id.");
      if (job.status !== "cancelled") throw new ToolError(`The job is ${job.status}, so it cannot be cancelled.`);
      return text({ id: job.id, status: job.status });
    }
    case "post_report": {
      const r = await box.addReport(str(args, "title"), str(args, "body"), str(args, "sender", false) || "claude");
      return text({ id: r.id, created_at: r.created_at });
    }
    case "read_reports": {
      const rows = await box.readReports(bool(args, "unread_only", true), int(args, "limit", 20, 50), bool(args, "mark_read", true));
      return text(rows.length ? rows : "No reports.");
    }
    case "bridge_status":
      return text(await box.status());
    case "list_sessions": {
      const rows = await box.listSessions(bool(args, "include_ended", false), 50);
      return text(rows.length ? rows.map(view) : "No sessions. Start one with start_session, or ask the user to open a window with duet-code.");
    }
    case "start_session": {
      const workspace = str(args, "workspace", false) || workspaces[0];
      if (!workspaces.includes(workspace)) throw new ToolError(`Unknown workspace '${workspace}'. Use one of: ${workspaces.join(", ")}.`);
      const mode = str(args, "mode", false) || "read";
      if (mode !== "read" && mode !== "work") throw new ToolError("'mode' must be read or work.");
      const ms = wait(args);
      const { session } = await box.startHeadless(str(args, "name"), workspace, mode, str(args, "message"));
      const replies = ms ? await box.waitForDuet(session.id, ms, true, 20) : [];
      return text({ session: view(session), replies, note: replies.length ? undefined : "The Mac will answer in its next turn. Call read_messages with this session_id." });
    }
    case "send_message": {
      const id = str(args, "session_id");
      const s = await box.getSession(id);
      if (!s) throw new ToolError("No session has that id. Call list_sessions.");
      if (s.status === "ended") throw new ToolError("That session has ended. Start a new one with start_session.");
      const ms = wait(args);
      const m = await box.sendToCode(id, str(args, "text"));
      const replies = ms ? await box.waitForDuet(id, ms, true, 20) : [];
      const live = s.kind === "live" ? (await box.listSessions(false, 50)).find((r) => r.id === id)?.connected : null;
      const note = replies.length ? undefined
        : live === false ? "The window is not connected right now. It gets the message when it reconnects."
        : "No answer yet. Call read_messages with this session_id.";
      return text({ sent: m.id, replies, note });
    }
    case "read_messages": {
      const id = str(args, "session_id", false) || null;
      const rows = await box.waitForDuet(id, wait(args), true, int(args, "limit", 20, 50));
      return text(rows.length ? rows : "No new messages.");
    }
    case "end_session": {
      const s = await box.endSession(str(args, "session_id"));
      if (!s) throw new ToolError("No session has that id.");
      return text({ id: s.id, status: s.status });
    }
    case "open_on_mac": {
      const id = str(args, "session_id");
      const s = await box.getSession(id);
      if (!s) throw new ToolError("No session has that id.");
      if (s.kind !== "headless") throw new ToolError("That session is already a window on the Mac.");
      if (s.status === "busy") throw new ToolError("That session is in the middle of a turn. Try again when it answers.");
      if (s.turns === 0) throw new ToolError("That session has not finished its first turn yet, so there is nothing to open.");
      // Mark it live first, so the Mac never runs a background turn while the window opens on the same conversation.
      await box.registerLive(id, "", "", "");
      const c = await box.addCommand("open_on_mac", id);
      return text({ queued: c.id, note: "The Mac opens the window within a few seconds if it is awake." });
    }
    default:
      throw new ToolError(`Unknown tool '${name}'.`);
  }
}

// The RPC stub's own type is too deep for the checker, so callers see plain async methods.
type MailboxApi = {
  [K in keyof Mailbox]: Mailbox[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
};

export function mailbox(env: Env): MailboxApi {
  return env.MAILBOX.get(env.MAILBOX.idFromName("main")) as unknown as MailboxApi;
}

export function workspaceList(env: Env): string[] {
  return (env.WORKSPACES || "default").split(",").map((s) => s.trim()).filter(Boolean);
}

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const rpcError = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleOne(env: Env, msg: RpcMessage): Promise<object | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid request");
  }
  // A notification has no id and gets no reply.
  if (msg.id === undefined) return null;
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return {
        jsonrpc: "2.0", id: msg.id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id: msg.id, result: { tools: tools(workspaceList(env)) } };
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return { jsonrpc: "2.0", id: msg.id, result: await callTool(env, name, args) };
      } catch (e) {
        if (e instanceof ToolError) {
          return { jsonrpc: "2.0", id: msg.id, result: { ...text(e.message), isError: true } };
        }
        throw e;
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleOne(env, m as RpcMessage)))).filter(Boolean);
    return replies.length ? Response.json(replies) : new Response(null, { status: 202 });
  }
  const reply = await handleOne(env, body as RpcMessage);
  return reply ? Response.json(reply) : new Response(null, { status: 202 });
}
