// End-to-end over real HTTP: OAuth (with a fake GitHub) -> bearer token -> MCP Streamable HTTP via the SDK client.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { storeFactory } from "../src/http.js";
import { parseAllowlist } from "../src/oauth.js";
import { TOOL_NAMES, VERSION } from "../src/server.js";
import { close, pkce, register, signIn, startApp, startFakeGitHub, token } from "./http-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const realFile = resolve(here, "../../data/prayers.json");

let dir: string;
let file: string;
let gh: Awaited<ReturnType<typeof startFakeGitHub>>;
let app: Awaited<ReturnType<typeof startApp>>;
const allowed = { v: "testuser" };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "prayer-tower-http-"));
  mkdirSync(join(dir, "data"));
  file = join(dir, "data", "prayers.json");
  copyFileSync(realFile, file);
  gh = await startFakeGitHub();
  app = await startApp(gh.url, {
    storeFor: storeFactory({ mode: "local", filePath: file }),
    allowedUsers: () => parseAllowlist(allowed.v),
  });
});
afterAll(async () => {
  await close(app.server);
  await close(gh.server);
  rmSync(dir, { recursive: true, force: true });
});

describe("hosted HTTP server end to end", () => {
  let accessToken: string;
  let refreshToken: string;
  let clientId: string;
  let redirectUri: string;

  it("GET /healthz", async () => {
    const r = await fetch(`${app.base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: VERSION, mode: "local" });
  });

  it("/mcp without a token -> 401 with resource_metadata; GET /mcp -> 405", async () => {
    const r = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
    const www = r.headers.get("www-authenticate")!;
    expect(www).toMatch(/^Bearer /);
    expect(www).toContain(`resource_metadata="${app.base}/.well-known/oauth-protected-resource/mcp"`);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-expose-headers")).toMatch(/WWW-Authenticate/);

    const bogus = await fetch(`${app.base}/mcp`, { method: "POST", headers: { Authorization: "Bearer nope.nope", "Content-Type": "application/json" }, body: "{}" });
    expect(bogus.status).toBe(401);

    const g = await fetch(`${app.base}/mcp`);
    expect(g.status).toBe(405);
    expect(((await g.json()) as any).jsonrpc).toBe("2.0");
    const d = await fetch(`${app.base}/mcp`, { method: "DELETE" });
    expect(d.status).toBe(405);
  });

  it("serves protected-resource and authorization-server metadata", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const r = await fetch(app.base + path);
      expect(r.status, path).toBe(200);
      const prm = (await r.json()) as any;
      expect(prm.resource).toBe(`${app.base}/mcp`);
      expect(prm.authorization_servers).toEqual([`${app.base}/`]);
    }
    const as = (await (await fetch(`${app.base}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(as.issuer).toBe(`${app.base}/`);
    expect(as.authorization_endpoint).toBe(`${app.base}/authorize`);
    expect(as.token_endpoint).toBe(`${app.base}/token`);
    expect(as.registration_endpoint).toBe(`${app.base}/register`);
    expect(as.revocation_endpoint).toBe(`${app.base}/revoke`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("registers, signs in through GitHub and gets tokens", async () => {
    redirectUri = "http://127.0.0.1:65000/cb";
    const reg = await register(app.base, [redirectUri]);
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as any;
    clientId = client.client_id;
    expect(client.redirect_uris).toEqual([redirectUri]);
    expect(client.client_secret).toBeUndefined();

    const { verifier, challenge } = pkce();
    const s = await signIn(app.base, { clientId, redirectUri, challenge, state: "opaque-state-123", resource: `${app.base}/mcp` });
    expect(s.authorize.status).toBe(302);
    const toGh = new URL(s.toGitHub!);
    expect(toGh.origin).toBe(gh.url);
    expect(toGh.searchParams.get("client_id")).toBe("gh-client-id");
    expect(toGh.searchParams.get("redirect_uri")).toBe(`${app.base}/oauth/github/callback`);
    expect(toGh.searchParams.get("scope")).toBe("read:user");
    expect(toGh.searchParams.get("allow_signup")).toBe("false");
    expect(s.toCallback!.startsWith(`${app.base}/oauth/github/callback?`)).toBe(true);
    expect(s.callback!.status).toBe(302);
    const back = new URL(s.callback!.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
    expect(back.searchParams.get("state")).toBe("opaque-state-123");
    const code = back.searchParams.get("code")!;
    expect(code).toBeTruthy();

    const t = await token(app.base, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: `${app.base}/mcp` });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    accessToken = t.body.access_token;
    refreshToken = t.body.refresh_token;
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
  });

  it("uses the MCP server with the SDK client (stateless Streamable HTTP)", async () => {
    const before = readFileSync(file, "utf8");
    const client = new Client({ name: "e2e", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("prayer-tower");
    expect(client.getInstructions()).toMatch(/Signed in as @TestUser/);
    expect(client.getInstructions()).toMatch(/lost if the server restarts/);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.find((t) => t.name === "publish")!.description).toMatch(/hosted server/);

    const res = (await client.callTool({
      name: "add_prayer_request",
      arguments: {
        name: { en: "HTTP Test Person", te: "హెచ్‌టీటీపీ టెస్ట్" },
        items: [{ en: "Healing.", te: "స్వస్థత." }],
      },
    })) as any;
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Added "http-test-person-[a-z0-9]{4}"/);
    const after = readFileSync(file, "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain("HTTP Test Person");

    const pv = (await client.callTool({ name: "preview_changes", arguments: {} })) as any;
    expect(pv.content[0].text).toMatch(/^Signed in as @TestUser\./);
    const pub = (await client.callTool({ name: "publish", arguments: {} })) as any;
    expect(pub.content[0].text).toMatch(/via prayer-tower MCP by @TestUser/);
    await client.close();
  });

  it("rejects oversized /mcp bodies", async () => {
    const r = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(200_000) } }),
    });
    expect(r.status).toBe(413);
  });

  it("refresh_token grant rotates; the old refresh token is rejected", async () => {
    const t = await token(app.base, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    expect(t.status).toBe(200);
    expect(t.body.refresh_token).not.toBe(refreshToken);
    const again = await token(app.base, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
    const r = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.body.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).result.serverInfo.name).toBe("prayer-tower");
  });

  it("removing the user from the allowlist locks them out immediately", async () => {
    allowed.v = "someoneelse";
    try {
      const r = await fetch(`${app.base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(r.status).toBe(401);
    } finally {
      allowed.v = "testuser";
    }
  });

  it("a non-allowlisted GitHub user (Mallory) gets the 403 page", async () => {
    gh.state.user = "Mallory";
    try {
      const s = await signIn(app.base, { clientId, redirectUri, challenge: pkce().challenge, state: "m" });
      expect(s.callback!.status).toBe(403);
      expect(s.callback!.headers.get("location")).toBeNull();
      expect(await s.callback!.text()).toContain("Mallory");
    } finally {
      gh.state.user = "TestUser";
    }
  });
});
