// Shared helpers for the HTTP/OAuth tests: a fake GitHub OAuth server and an app launcher on port 0.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpApp, type HttpAppOptions } from "../src/http.js";

export const SECRET = "test-session-secret-0123456789-abcdefghij";
export const GH_CLIENT_ID = "gh-client-id";
export const GH_CLIENT_SECRET = "gh-client-secret";

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

export const close = (s: Server) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });

/** Fake github.com + api.github.com. `user` is who "signs in"; "DENY" simulates the user cancelling. */
export async function startFakeGitHub() {
  const state = { user: "TestUser", tokenCalls: 0 };
  const { server, url } = await listen(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    if (req.method === "GET" && u.pathname === "/login/oauth/authorize") {
      const back = new URL(u.searchParams.get("redirect_uri")!);
      if (state.user === "DENY") back.searchParams.set("error", "access_denied");
      else back.searchParams.set("code", `fake-${state.user}`);
      back.searchParams.set("state", u.searchParams.get("state")!);
      res.writeHead(302, { Location: back.href }).end();
      return;
    }
    if (req.method === "POST" && u.pathname === "/login/oauth/access_token") {
      state.tokenCalls++;
      let body = "";
      for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      res.setHeader("Content-Type", "application/json");
      if (p.get("client_id") !== GH_CLIENT_ID || p.get("client_secret") !== GH_CLIENT_SECRET || !p.get("code")?.startsWith("fake-")) {
        res.end(JSON.stringify({ error: "bad_verification_code" }));
        return;
      }
      res.end(JSON.stringify({ access_token: `gho_${p.get("code")!.slice(5)}`, token_type: "bearer", scope: "read:user" }));
      return;
    }
    if (req.method === "GET" && u.pathname === "/user") {
      const m = /^Bearer gho_(.+)$/.exec(req.headers.authorization ?? "");
      if (!m) {
        res.writeHead(401).end("{}");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ login: m[1], id: 1 }));
      return;
    }
    res.writeHead(404).end();
  });
  return { url, server, state };
}

/** Start the hosted app on 127.0.0.1:<random port>, with PUBLIC_URL pointing at itself. */
export async function startApp(ghUrl: string, opts: Partial<HttpAppOptions> & Pick<HttpAppOptions, "storeFor">) {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { app, provider } = createHttpApp({
    publicUrl: base,
    sessionSecret: SECRET,
    github: {
      clientId: GH_CLIENT_ID,
      clientSecret: GH_CLIENT_SECRET,
      authorizeUrl: `${ghUrl}/login/oauth/authorize`,
      tokenUrl: `${ghUrl}/login/oauth/access_token`,
      userUrl: `${ghUrl}/user`,
    },
    mode: "local",
    log: () => {},
    ...opts,
  });
  server.on("request", app);
  return { base, server, provider };
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function register(base: string, redirectUris: string[], extra: Record<string, unknown> = {}) {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: "Test client", token_endpoint_auth_method: "none", ...extra }),
  });
}

/** /authorize -> fake GitHub -> /oauth/github/callback. Returns the callback's response (not followed). */
type AuthorizeParams = { clientId: string; redirectUri: string; challenge: string; state?: string; resource?: string };

export function authorizeUrl(base: string, p: AuthorizeParams) {
  const a = new URL(`${base}/authorize`);
  a.searchParams.set("response_type", "code");
  a.searchParams.set("client_id", p.clientId);
  a.searchParams.set("redirect_uri", p.redirectUri);
  a.searchParams.set("code_challenge", p.challenge);
  a.searchParams.set("code_challenge_method", "S256");
  if (p.state) a.searchParams.set("state", p.state);
  if (p.resource) a.searchParams.set("resource", p.resource);
  return a;
}

export async function signIn(base: string, p: AuthorizeParams) {
  const r1 = await fetch(authorizeUrl(base, p), { redirect: "manual" });
  if (r1.status !== 302) return { authorize: r1 };
  const toGitHub = r1.headers.get("location")!;
  const r2 = await fetch(toGitHub, { redirect: "manual" });
  const toCallback = r2.headers.get("location")!;
  const r3 = await fetch(toCallback, { redirect: "manual" });
  return { authorize: r1, toGitHub, toCallback, callback: r3 };
}

export async function token(base: string, form: Record<string, string>) {
  const r = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: r.status, body: (await r.json()) as any };
}
