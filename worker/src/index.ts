// Duet Bridge Worker.
//   /mcp        the connector Claude Duet (and any Claude app) calls, behind OAuth
//   /authorize  the passphrase sign-in page
//   /bridge/*   the Mac checker's private door, behind a bearer token
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize } from "./authorize";
import { handleBridge } from "./bridge";
import { handleMcp } from "./mcp";
import type { Mailbox } from "./mailbox";

export { Mailbox } from "./mailbox";

export interface Env {
  OAUTH_KV: KVNamespace;
  MAILBOX: DurableObjectNamespace<Mailbox>;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_URL: string;
  WORKSPACES: string;
  OWNER_PASSPHRASE: string;
  BRIDGE_TOKEN: string;
}

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/authorize") return handleAuthorize(request, env);
    if (path.startsWith("/bridge/")) return handleBridge(request, env);
    if (path === "/") return new Response("Duet Bridge is running.\n", { headers: { "Content-Type": "text/plain" } });
    return new Response("Not Found", { status: 404 });
  },
};

const apiHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleMcp(request, env);
  },
};

// The resource URL must match the URL typed into Claude exactly, and it is known only
// after deploy, so the provider is built from PUBLIC_URL on the first request.
let provider: OAuthProvider<Env> | null = null;
let builtFor = "";

function getProvider(env: Env): OAuthProvider<Env> {
  const base = env.PUBLIC_URL.replace(/\/+$/, "").toLowerCase();
  if (!provider || builtFor !== base) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["mailbox"],
      resourceMetadata: { resource: `${base}/mcp`, authorization_servers: [base] },
      accessTokenTTL: 60 * 60,
      refreshTokenTTL: 90 * 24 * 60 * 60,
    });
    builtFor = base;
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(env).fetch(request, env, ctx);
  },
};
