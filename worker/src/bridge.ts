// The Mac's private door. Every call carries the bearer token in BRIDGE_TOKEN.
// Jobs (the one-shot path):
//   POST /bridge/claim                   take the oldest queued job (also records a check-in)
//   POST /bridge/jobs/<id>/finish        {ok, result}
//   GET  /bridge/jobs?status=            list jobs
// Sessions (the conversation path):
//   POST /bridge/work                    {turns, jobs}: a command for the Mac, then a turn, then a job, if any
//   POST /bridge/turns/<sid>/finish      {ok, reply, started}
//   POST /bridge/sessions/live           {id?, name, workspace, focus}: a live window says hello
//   GET  /bridge/ws?session=<sid>        the live window's WebSocket
//   POST /bridge/sessions/<sid>/messages {body}: Code answers Duet in that session
//   POST /bridge/sessions/<sid>/focus    {focus}
//   POST /bridge/sessions/<sid>/end
//   GET  /bridge/sessions                list sessions
//   POST /bridge/messages                {body}: Code tells Duet something outside any session
// Reports and status:
//   POST /bridge/reports                 {title, body, sender}
//   GET  /bridge/reports                 unread reports, without marking them read
//   GET  /bridge/status                  counts and last check-in
import { sameSecret } from "./authorize";
import type { Env } from "./index";
import type { JobStatus } from "./mailbox";
import { mailbox } from "./mcp";

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

type Body = Record<string, unknown>;
const readBody = async (request: Request): Promise<Body | null> =>
  (await request.json().catch(() => null)) as Body | null;
const strOf = (b: Body | null, k: string) => (typeof b?.[k] === "string" ? (b[k] as string) : "");

export async function handleBridge(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !(await sameSecret(token, env.BRIDGE_TOKEN))) return bad("unauthorized", 401);

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["bridge", ...]
  const box = mailbox(env);
  const host = request.headers.get("X-Bridge-Host") ?? "mac";
  // "jobs/abc/finish" becomes "jobs/:id/finish". Only a path with an action after the id has an id.
  const route = `${request.method} ${parts.slice(1).map((p, i) => (i === 1 && parts.length > 3 ? ":id" : p)).join("/")}`;
  const id = parts[2] ?? "";

  switch (route) {
    // ---- jobs ----
    case "POST claim":
      return Response.json({ job: await box.claimJob(host) });
    case "POST jobs/:id/finish": {
      const body = await readBody(request);
      if (!body || typeof body.result !== "string") return bad("body needs ok and result");
      const job = await box.finishJob(id, body.ok === true, body.result);
      return job ? Response.json({ job }) : bad("no such job", 404);
    }
    case "GET jobs": {
      const status = (url.searchParams.get("status") ?? "all") as JobStatus | "all";
      return Response.json({ jobs: await box.listJobs(status, 50) });
    }

    // ---- sessions ----
    case "POST work": {
      const body = await readBody(request);
      const command = await box.claimCommand();
      if (command) return Response.json({ command });
      const turn = body?.turns === false ? null : await box.claimTurn(host);
      if (turn) return Response.json({ turn });
      const job = body?.jobs === false ? null : await box.claimJob(host);
      return Response.json(job ? { job } : {});
    }
    case "POST turns/:id/finish": {
      const body = await readBody(request);
      if (!body || typeof body.reply !== "string") return bad("body needs ok and reply");
      const s = await box.finishTurn(id, body.ok === true, body.reply, body.started === true);
      return s ? Response.json({ session: s }) : bad("no such session", 404);
    }
    case "POST sessions/live": {
      const body = await readBody(request);
      const s = await box.registerLive(strOf(body, "id") || null, strOf(body, "name"), strOf(body, "workspace"), strOf(body, "focus"));
      return Response.json({ session: s });
    }
    case "GET ws": {
      // The socket lives in the mailbox object itself, so hand it the upgrade request.
      return env.MAILBOX.get(env.MAILBOX.idFromName("main")).fetch(request);
    }
    case "POST sessions/:id/messages": {
      const body = await readBody(request);
      if (!strOf(body, "body")) return bad("body needs body");
      if (!(await box.getSession(id))) return bad("no such session", 404);
      return Response.json({ message: await box.sendToDuet(id, strOf(body, "body")) });
    }
    case "POST sessions/:id/focus": {
      const s = await box.setFocus(id, strOf(await readBody(request), "focus"));
      return s ? Response.json({ session: s }) : bad("no such session", 404);
    }
    case "POST sessions/:id/end": {
      const s = await box.endSession(id);
      return s ? Response.json({ session: s }) : bad("no such session", 404);
    }
    case "GET sessions":
      return Response.json({ sessions: await box.listSessions(url.searchParams.get("all") === "1", 50) });
    case "POST messages": {
      const body = await readBody(request);
      if (!strOf(body, "body")) return bad("body needs body");
      return Response.json({ message: await box.sendToDuet(null, strOf(body, "body")) });
    }

    // ---- reports and status ----
    case "POST reports": {
      const body = await readBody(request);
      if (!strOf(body, "title") || !strOf(body, "body")) return bad("body needs title and body");
      return Response.json({ report: await box.addReport(strOf(body, "title"), strOf(body, "body"), strOf(body, "sender") || "claude-code") });
    }
    case "GET reports":
      return Response.json({ reports: await box.readReports(true, 50, false) });
    case "GET status":
      return Response.json(await box.status());
  }
  return bad("not found", 404);
}
