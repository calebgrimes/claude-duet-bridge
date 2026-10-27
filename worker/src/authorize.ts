// The sign-in page. One owner, one passphrase. Access goes only to claude.ai or to a
// Claude Code sign-in on this computer, never to another site.
import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./index";
import { mailbox } from "./mcp";

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function redirectAllowed(uri: string): boolean {
  if (uri === CLAUDE_CALLBACK) return true;
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function digest(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

export async function sameSecret(given: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function page(details: ConsentDescription, handle: string, error = ""): string {
  const name = escape(details.clientName);
  const local = details.redirectIsLoopback
    ? `<p class="warn">▲ This sends access to an app on this computer. Continue only if you just started the sign-in from Claude Code.</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Duet Bridge sign-in</title>
<style>
  :root { --bg:#fafaf7; --fg:#1c1c1a; --muted:#5c5c57; --line:#d9d9d2; --accent:#0072b2; --warn:#d55e00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1a1a18; --fg:#ececE6; --muted:#a3a39b; --line:#3a3a36; --accent:#56b4e9; --warn:#e69f00; } }
  body { background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; margin:0; padding:32px 16px; }
  main { max-width:440px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 8px; }
  p { color:var(--muted); }
  .warn { color:var(--warn); }
  .err { color:var(--warn); font-weight:600; }
  input[type=password] { width:100%; box-sizing:border-box; padding:10px; font-size:16px; border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--fg); }
  .row { display:flex; gap:12px; margin-top:16px; }
  button { padding:10px 18px; font-size:16px; border-radius:6px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
</style></head>
<body><main>
<h1>Allow ${name} to use Duet Bridge?</h1>
<p>Duet Bridge is the mailbox between Claude Duet and Claude Code on your Mac. Access goes to <strong>${escape(details.redirectHost)}</strong>.</p>
${local}
${error ? `<p class="err">✖ ${escape(error)}</p>` : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="pw">Passphrase</label>
  <input id="pw" type="password" name="passphrase" autocomplete="current-password" autofocus>
  <div class="row">
    <button class="primary" name="decision" value="approve">✔ Allow</button>
    <button name="decision" value="deny">Deny</button>
  </div>
</form>
</main></body></html>`;
}

const plain = (message: string, status = 400) =>
  new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      if (!redirectAllowed(authRequest.redirectUri)) {
        return plain("Duet Bridge only signs in to Claude. This request asked to send access somewhere else.", 403);
      }
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(page(details, consent.handle), { headers: consent.headers });
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }

      const box = mailbox(env);
      if (await box.authLocked()) {
        return plain("Too many wrong passphrases. Wait 15 minutes, then start the sign-in again from Claude.", 429);
      }
      if (!(await sameSecret(String(form.get("passphrase") ?? ""), env.OWNER_PASSPHRASE))) {
        await box.authFailed();
        return plain("Wrong passphrase. Go back and try again.", 401);
      }

      const approved = await oauth.approveConsent(request, handle, { scope: ["mailbox"] });
      if (!redirectAllowed(approved.request.redirectUri)) {
        return plain("Duet Bridge only signs in to Claude.", 403);
      }
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: "owner",
        metadata: { label: "Duet Bridge owner" },
        scope: approved.request.scope,
        props: { userId: "owner" },
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }

    return plain("Method Not Allowed", 405);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo && redirectAllowed(error.redirectUri ?? "")) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) return plain(error.description);
    if (error instanceof CimdFetchError) return plain("This app could not be verified.");
    throw error;
  }
}
