// The MCP endpoint. Stateless Streamable HTTP: every POST carries JSON-RPC and gets a JSON reply.
// No server-to-client stream, so GET and DELETE answer 405.
import type { Env } from "./index";
import type { JobStatus, Mailbox } from "./mailbox";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "duet-bridge", title: "Duet Bridge", version: "1.0.0" };

const INSTRUCTIONS = `Duet Bridge is a mailbox between you and Claude Code on the owner's Mac.
- To ask Claude Code to do work on the Mac, call send_job. The Mac checks the mailbox about every 5 minutes, so results are not instant. Call get_job later to read the result.
- Jobs on the Mac are read-only: Claude Code can read files in the job's workspace folder and use the read-only tools the owner allowed, and it answers in text. It cannot send email, edit files or run commands.
- Claude Code leaves you reports with post_report. Call read_reports to collect them.
- Call bridge_status to see when the Mac last checked in. If that is more than 15 minutes ago, the Mac is probably asleep, so tell the owner the job will wait.`;

const STATUSES = ["queued", "running", "done", "failed", "cancelled"];

function tools(workspaces: string[]) {
  return [
    {
      name: "send_job",
      title: "Send a job to Claude Code",
      description:
        "Queue a read-only job for Claude Code on the owner's Mac. Write the instructions as a complete brief: Claude Code sees only this text. Returns a job id. The Mac picks jobs up about every 5 minutes.",
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
      description: "Job counts, unread reports, and when the Mac last checked the mailbox.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];
}

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
