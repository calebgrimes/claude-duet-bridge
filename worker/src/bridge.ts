// The Mac checker's private door. Every call carries the bearer token in BRIDGE_TOKEN.
//   POST /bridge/claim             take the oldest queued job (also records a check-in)
//   POST /bridge/jobs/<id>/finish  {ok, result}
//   POST /bridge/reports           {title, body, sender}
//   GET  /bridge/jobs?status=      list jobs
//   GET  /bridge/reports           unread reports, without marking them read
//   GET  /bridge/status            counts and last check-in
import { sameSecret } from "./authorize";
import type { Env } from "./index";
import type { JobStatus } from "./mailbox";
import { mailbox } from "./mcp";

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

export async function handleBridge(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !(await sameSecret(token, env.BRIDGE_TOKEN))) return bad("unauthorized", 401);

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["bridge", ...]
  const box = mailbox(env);
  const host = request.headers.get("X-Bridge-Host") ?? "mac";

  if (request.method === "POST" && parts[1] === "claim" && parts.length === 2) {
    return Response.json({ job: await box.claimJob(host) });
  }
  if (request.method === "POST" && parts[1] === "jobs" && parts[3] === "finish" && parts.length === 4) {
    const body = (await request.json().catch(() => null)) as { ok?: boolean; result?: string } | null;
    if (!body || typeof body.result !== "string") return bad("body needs ok and result");
    const job = await box.finishJob(parts[2], body.ok === true, body.result);
    return job ? Response.json({ job }) : bad("no such job", 404);
  }
  if (request.method === "POST" && parts[1] === "reports" && parts.length === 2) {
    const body = (await request.json().catch(() => null)) as { title?: string; body?: string; sender?: string } | null;
    if (!body?.title || !body?.body) return bad("body needs title and body");
    return Response.json({ report: await box.addReport(body.title, body.body, body.sender ?? "claude-code") });
  }
  if (request.method === "GET" && parts[1] === "jobs" && parts.length === 2) {
    const status = (url.searchParams.get("status") ?? "all") as JobStatus | "all";
    return Response.json({ jobs: await box.listJobs(status, 50) });
  }
  if (request.method === "GET" && parts[1] === "reports" && parts.length === 2) {
    return Response.json({ reports: await box.readReports(true, 50, false) });
  }
  if (request.method === "GET" && parts[1] === "status" && parts.length === 2) {
    return Response.json(await box.status());
  }
  return bad("not found", 404);
}
