import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createHttpApp, HttpConfigError, loadHttpConfig } from "../src/http.js";
import {
  ACCESS_TTL,
  escapeHtml,
  GitHubOAuthProvider,
  isAllowedRedirectUri,
  isTrustedRedirectUri,
  parseAllowlist,
  Signer,
} from "../src/oauth.js";
import { authorizeUrl, close, pkce, register, SECRET, signIn, startApp, startFakeGitHub, token } from "./http-helpers.js";

const noStore = async () => {
  throw new Error("store not used in these tests");
};

// ---------------------------------------------------------------------------
// Unit: provider with an injectable clock and allowlist
// ---------------------------------------------------------------------------

function makeProvider() {
  const env = { ALLOWED_GITHUB_USERS: "TestUser, @other" };
  const clock = { t: Date.UTC(2026, 10, 19, 12, 0, 0) };
  const provider = new GitHubOAuthProvider({
    publicUrl: "https://mcp.example.com",
    sessionSecret: SECRET,
    github: { clientId: "x", clientSecret: "y" },
    allowedUsers: () => parseAllowlist(env.ALLOWED_GITHUB_USERS),
    now: () => clock.t,
  });
  const client = provider.registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", client_name: "Claude" });
  const code = (over: Record<string, unknown> = {}, c: OAuthClientInformationFull = client) =>
    provider.signer.sign(
      "code",
      { cid: c.client_id, ru: c.redirect_uris[0], cc: "challenge", sub: "TestUser", sc: [], rs: provider.resource, jti: Math.random().toString(36), ...over },
      300,
    );
  return { provider, client, env, clock, code };
}

describe("signed blobs", () => {
  it("round-trips and rejects tampering, wrong typ and expiry", () => {
    let t = 1_000_000_000_000;
    const s = new Signer(SECRET, () => t);
    const tok = s.sign("access", { sub: "a" }, 60);
    expect(s.verify(tok, "access")?.sub).toBe("a");
    expect(s.verify(tok, "refresh")).toBeNull();
    const [body, sig] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "b", typ: "access", iat: 0 })).toString("base64url");
    expect(s.verify(`${forged}.${sig}`, "access")).toBeNull();
    expect(s.verify(`${body}.${sig!.slice(0, -2)}AA`, "access")).toBeNull();
    expect(new Signer(SECRET + "x").verify(tok, "access")).toBeNull();
    t += 61_000;
    expect(s.verify(tok, "access")).toBeNull();
  });

  it("refuses a short SESSION_SECRET", () => {
    expect(() => new Signer("too-short")).toThrow(/at least 32/);
  });
});

describe("client registration (stateless)", () => {
  it("client_id decodes back to the registration; tampered ids are rejected", () => {
    const { provider, client } = makeProvider();
    const got = provider.getClient(client.client_id)!;
    expect(got.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(got.client_name).toBe("Claude");
    expect(got.token_endpoint_auth_method).toBe("none");
    expect(got.client_secret).toBeUndefined();
    const [body, sig] = client.client_id.split(".");
    const evil = JSON.parse(Buffer.from(body!, "base64url").toString());
    evil.ru = ["https://evil.example/cb"];
    expect(provider.getClient(`${Buffer.from(JSON.stringify(evil)).toString("base64url")}.${sig}`)).toBeUndefined();
    expect(provider.getClient("garbage")).toBeUndefined();
    // a different kind of signed blob is not a client id
    expect(provider.getClient(provider.signer.sign("access", { ru: [] }))).toBeUndefined();
  });

  it("confidential clients get a client_secret derived from client_id", () => {
    const { provider } = makeProvider();
    const c = provider.registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_basic" });
    expect(c.token_endpoint_auth_method).toBe("client_secret_post");
    expect(c.client_secret).toBeTruthy();
    expect(c.client_secret_expires_at).toBe(0);
    expect(provider.getClient(c.client_id)!.client_secret).toBe(c.client_secret);
  });

  it("redirect URI policy", () => {
    for (const ok of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
      "http://localhost:6274/oauth/callback",
      "http://127.0.0.1:33418/callback",
      "http://[::1]:8080/cb",
      "https://example.org/cb?x=1",
    ])
      expect(isAllowedRedirectUri(ok), ok).toBe(true);
    for (const bad of ["http://example.com/cb", "http://claude.ai/api/mcp/auth_callback", "javascript:alert(1)", "cursor://cb", "https://a.com/cb#frag", "not a url", "https://u:p@a.com/cb"])
      expect(isAllowedRedirectUri(bad), bad).toBe(false);
    expect(isTrustedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isTrustedRedirectUri("http://127.0.0.1:1234/cb")).toBe(true);
    expect(isTrustedRedirectUri("https://claude.ai.evil.com/api/mcp/auth_callback")).toBe(false);
    expect(isTrustedRedirectUri("https://example.org/cb")).toBe(false);
    const { provider } = makeProvider();
    expect(() => provider.registerClient({ redirect_uris: ["http://evil.example/cb"] })).toThrow(/redirect_uri not allowed/);
  });

  it("allowlist parsing and HTML escaping", () => {
    expect([...parseAllowlist(" Alice, @BOB ,,carol ")]).toEqual(["alice", "bob", "carol"]);
    expect(escapeHtml(`<img src=x onerror="a">'&`)).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;&#39;&amp;");
  });
});

describe("codes and tokens", () => {
  it("authorization codes are single-use and bound to the client and redirect_uri", async () => {
    const { provider, client, code } = makeProvider();
    const other = provider.registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" });
    const c = code();
    await expect(provider.challengeForAuthorizationCode(other, c)).rejects.toThrow(/another client/);
    await expect(provider.exchangeAuthorizationCode(client, c, undefined, "https://claude.com/api/mcp/auth_callback")).rejects.toThrow(/redirect_uri/);
    expect(await provider.challengeForAuthorizationCode(client, c)).toBe("challenge");
    const t = await provider.exchangeAuthorizationCode(client, c, undefined, "https://claude.ai/api/mcp/auth_callback");
    expect(t.access_token).toBeTruthy();
    await expect(provider.exchangeAuthorizationCode(client, c)).rejects.toThrow(/already been used/);
    await expect(provider.challengeForAuthorizationCode(client, c)).rejects.toThrow(/already been used/);
  });

  it("access tokens expire (injectable clock)", async () => {
    const { provider, client, code, clock } = makeProvider();
    const t = await provider.exchangeAuthorizationCode(client, code());
    const info = await provider.verifyAccessToken(t.access_token);
    expect(info.extra?.login).toBe("TestUser");
    expect(info.clientId).toBe(client.client_id);
    expect(info.resource?.href).toBe("https://mcp.example.com/mcp");
    expect(info.expiresAt).toBe(Math.floor(clock.t / 1000) + ACCESS_TTL);
    clock.t += (ACCESS_TTL - 5) * 1000;
    await expect(provider.verifyAccessToken(t.access_token)).resolves.toBeTruthy();
    clock.t += 10_000;
    await expect(provider.verifyAccessToken(t.access_token)).rejects.toThrow(/expired/);
  });

  it("expired authorization codes are rejected", async () => {
    const { provider, client, code, clock } = makeProvider();
    const c = code();
    clock.t += 301_000;
    await expect(provider.challengeForAuthorizationCode(client, c)).rejects.toThrow(/expired/);
  });

  it("re-checks the allowlist on every request", async () => {
    const { provider, client, code, env } = makeProvider();
    const t = await provider.exchangeAuthorizationCode(client, code());
    await expect(provider.verifyAccessToken(t.access_token)).resolves.toBeTruthy();
    env.ALLOWED_GITHUB_USERS = "other";
    await expect(provider.verifyAccessToken(t.access_token)).rejects.toThrow(/not allowed/);
    await expect(provider.exchangeRefreshToken(client, t.refresh_token!)).rejects.toThrow(/no longer allowed/);
    env.ALLOWED_GITHUB_USERS = "OTHER,testuser";
    await expect(provider.verifyAccessToken(t.access_token)).resolves.toBeTruthy();
  });

  it("rotates refresh tokens and rejects reuse", async () => {
    const { provider, client, code } = makeProvider();
    const t1 = await provider.exchangeAuthorizationCode(client, code());
    const t2 = await provider.exchangeRefreshToken(client, t1.refresh_token!);
    expect(t2.refresh_token).toBeTruthy();
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await provider.verifyAccessToken(t2.access_token)).extra?.login).toBe("TestUser");
    await expect(provider.exchangeRefreshToken(client, t1.refresh_token!)).rejects.toThrow(/already been used/);
    const t3 = await provider.exchangeRefreshToken(client, t2.refresh_token!);
    expect(t3.access_token).toBeTruthy();
    const other = provider.registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" });
    await expect(provider.exchangeRefreshToken(other, t3.refresh_token!)).rejects.toThrow(/another client/);
  });

  it("rejects one token kind used as another (typ confusion)", async () => {
    const { provider, client, code } = makeProvider();
    const c = code();
    const t = await provider.exchangeAuthorizationCode(client, code());
    await expect(provider.verifyAccessToken(t.refresh_token!)).rejects.toThrow(/Invalid/);
    await expect(provider.verifyAccessToken(c)).rejects.toThrow(/Invalid/);
    await expect(provider.verifyAccessToken(client.client_id)).rejects.toThrow(/Invalid/);
    await expect(provider.exchangeRefreshToken(client, t.access_token)).rejects.toThrow(/Invalid/);
    await expect(provider.exchangeAuthorizationCode(client, t.access_token)).rejects.toThrow(/Invalid/);
    await expect(provider.exchangeAuthorizationCode(client, t.refresh_token!)).rejects.toThrow(/Invalid/);
  });

  it("revocation (best effort, in memory)", async () => {
    const { provider, client, code } = makeProvider();
    const t = await provider.exchangeAuthorizationCode(client, code());
    await provider.revokeToken(client, { token: t.access_token });
    await expect(provider.verifyAccessToken(t.access_token)).rejects.toThrow(/revoked/);
    await provider.revokeToken(client, { token: t.refresh_token! });
    await expect(provider.exchangeRefreshToken(client, t.refresh_token!)).rejects.toThrow(/already been used/);
  });
});

describe("startup configuration", () => {
  const good = {
    PUBLIC_URL: "https://mcp.example.com/",
    SESSION_SECRET: SECRET,
    GITHUB_OAUTH_CLIENT_ID: "id",
    GITHUB_OAUTH_CLIENT_SECRET: "secret",
    ALLOWED_GITHUB_USERS: "alice",
    GITHUB_TOKEN: "github_pat_x",
  };
  it("accepts a complete environment", () => {
    const c = loadHttpConfig(good);
    expect(c.publicUrl).toBe("https://mcp.example.com");
    expect(c.store.mode).toBe("github");
    expect(c.port).toBe(3000);
  });
  it("lists every missing variable", () => {
    expect(() => loadHttpConfig({})).toThrow(HttpConfigError);
    try {
      loadHttpConfig({});
    } catch (e) {
      expect((e as Error).message).toMatch(/PUBLIC_URL, SESSION_SECRET, GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, ALLOWED_GITHUB_USERS, GITHUB_TOKEN/);
    }
  });
  it("refuses a short SESSION_SECRET and a non-https PUBLIC_URL", () => {
    expect(() => loadHttpConfig({ ...good, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET must be at least 32/);
    expect(() => loadHttpConfig({ ...good, PUBLIC_URL: "http://mcp.example.com" })).toThrow(/https/);
    expect(() => loadHttpConfig({ ...good, PUBLIC_URL: "https://mcp.example.com/mcp" })).toThrow(/origin only/);
    expect(() =>
      createHttpApp({ publicUrl: "https://mcp.example.com", sessionSecret: "short", github: { clientId: "a", clientSecret: "b" }, mode: "local", storeFor: noStore }),
    ).toThrow(/at least 32/);
  });
  it("local mode does not need GITHUB_TOKEN", () => {
    const { GITHUB_TOKEN, ...rest } = good;
    void GITHUB_TOKEN;
    expect(() => loadHttpConfig({ ...rest, PRAYER_TOWER_REPO_PATH: "/nonexistent" })).toThrow(/does not exist/);
    expect(() => loadHttpConfig(rest)).toThrow(/GITHUB_TOKEN/);
  });
});

// ---------------------------------------------------------------------------
// Over HTTP: PKCE, allowlist at the callback, consent page, registration policy
// ---------------------------------------------------------------------------

describe("OAuth over HTTP", () => {
  let gh: Awaited<ReturnType<typeof startFakeGitHub>>;
  let app: Awaited<ReturnType<typeof startApp>>;
  let server: Server;
  const redirectUri = "http://127.0.0.1:9/cb";
  let clientId: string;

  beforeAll(async () => {
    gh = await startFakeGitHub();
    app = await startApp(gh.url, { storeFor: noStore, allowedUsers: () => parseAllowlist("testuser") });
    server = app.server;
    const r = await register(app.base, [redirectUri]);
    expect(r.status).toBe(201);
    clientId = ((await r.json()) as any).client_id;
  });
  afterAll(async () => {
    await close(server);
    await close(gh.server);
  });

  it("registration rejects non-https, non-loopback redirect URIs", async () => {
    const r = await register(app.base, ["http://evil.example/cb"]);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_client_metadata");
  });

  it("token endpoint enforces PKCE", async () => {
    gh.state.user = "TestUser";
    const { verifier, challenge } = pkce();
    const s = await signIn(app.base, { clientId, redirectUri, challenge, state: "xyz" });
    expect(s.callback!.status).toBe(302);
    const code = new URL(s.callback!.headers.get("location")!).searchParams.get("code")!;
    const bad = await token(app.base, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: pkce().verifier, redirect_uri: redirectUri });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_grant");
    const ok = await token(app.base, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri });
    expect(ok.status).toBe(200);
    expect(ok.body.token_type).toBe("Bearer");
    const again = await token(app.base, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri });
    expect(again.body.error).toBe("invalid_grant");
  });

  it("non-allowlisted GitHub user gets a 403 page and no code", async () => {
    gh.state.user = "Mallory";
    const s = await signIn(app.base, { clientId, redirectUri, challenge: pkce().challenge, state: "s1" });
    expect(s.callback!.status).toBe(403);
    expect(s.callback!.headers.get("location")).toBeNull();
    const html = await s.callback!.text();
    expect(html).toContain("<strong>Mallory</strong>");
    expect(html).toMatch(/not allowed/);
    expect(s.callback!.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
  });

  it("GitHub access_denied is passed back to the client", async () => {
    gh.state.user = "DENY";
    const s = await signIn(app.base, { clientId, redirectUri, challenge: pkce().challenge, state: "s2" });
    const loc = new URL(s.callback!.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(redirectUri);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("s2");
    expect(loc.searchParams.get("code")).toBeNull();
    gh.state.user = "TestUser";
  });

  it("tampered GitHub state is rejected", async () => {
    const r = await fetch(`${app.base}/oauth/github/callback?code=fake-TestUser&state=abc.def`, { redirect: "manual" });
    expect(r.status).toBe(400);
  });

  it("unknown resource is rejected; non-Claude https redirect gets a consent page", async () => {
    // The SDK reports provider errors by redirecting straight back to the client from /authorize.
    const bad = await fetch(authorizeUrl(app.base, { clientId, redirectUri, challenge: pkce().challenge, state: "s3", resource: "https://other.example/mcp" }), { redirect: "manual" });
    expect(bad.status).toBe(302);
    const loc = new URL(bad.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_target");
    expect(loc.searchParams.get("state")).toBe("s3");

    const r = await register(app.base, ["https://app.example.org/cb"]);
    const cid = ((await r.json()) as any).client_id;
    const page = await signIn(app.base, { clientId: cid, redirectUri: "https://app.example.org/cb", challenge: pkce().challenge });
    expect(page.authorize.status).toBe(200);
    const html = await page.authorize.text();
    expect(html).toContain("app.example.org");
    expect(html).toContain("Continue with GitHub");
  });
});

describe("per-user drafts and actor attribution", () => {
  it("GitHub mode gives each login its own store (case-insensitive), retrying failed opens", async () => {
    const { storeFactory } = await import("../src/http.js");
    let n = 0;
    const storeFor = storeFactory(
      { mode: "github", token: "t", repo: "o/r", branch: "main", file: "data/prayers.json", publishMode: "pr" },
      {
        github: (async () => {
          n++;
          if (n === 1) throw new Error("boom");
          return { id: n } as never;
        }) as never,
      },
    );
    await expect(storeFor("alice")).rejects.toThrow("boom");
    const a1 = await storeFor("alice");
    const a2 = await storeFor("ALICE");
    const b = await storeFor("bob");
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(n).toBe(3);
  });

  it("commit message trailer and PR branch name include the actor", async () => {
    const { commitMessage } = await import("../src/ops.js");
    const { branchName } = await import("../src/store.js");
    const op = { type: "set_status", summary: "Archive prayer request: X" } as never;
    expect(commitMessage([op])).toBe("Archive prayer request: X\n\nvia prayer-tower MCP");
    expect(commitMessage([op], undefined, "Alice")).toBe("Archive prayer request: X\n\nvia prayer-tower MCP by @Alice");
    expect(branchName(new Date("2026-01-02T03:04:05Z"), "Alice")).toBe("prayer-update-20260102-030405-alice");
  });
});
