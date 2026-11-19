// Stateless OAuth 2.1 authorization server that delegates sign-in to GitHub.
//
// Nothing is stored server-side: client registrations, the GitHub round-trip state, authorization
// codes, access tokens and refresh tokens are all HMAC-SHA256-signed blobs (see `Signer`). Each blob
// carries a `typ` claim so one kind can never be accepted as another. Single use of codes and
// refresh tokens is enforced best-effort with in-memory sets (lost on restart, bounded by expiry).
//
// The SDK's mcpAuthRouter provides /authorize, /token, /register, /revoke and the metadata
// endpoints; this file supplies the OAuthServerProvider behind them plus the GitHub callback.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

export const ACCESS_TTL = 60 * 60; // 1 hour
export const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days
export const CODE_TTL = 5 * 60; // 5 minutes
export const STATE_TTL = 10 * 60; // 10 minutes
export const MIN_SECRET_LENGTH = 32;

// ---------------------------------------------------------------------------
// Signed blobs
// ---------------------------------------------------------------------------

export type TokenType = "client" | "ghstate" | "code" | "access" | "refresh";

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Compact signed tokens: base64url(JSON payload) "." base64url(HMAC-SHA256). */
export class Signer {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!secret || secret.length < MIN_SECRET_LENGTH)
      throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  nowSec() {
    return Math.floor(this.now() / 1000);
  }

  private mac(data: string) {
    return createHmac("sha256", this.secret).update(data).digest();
  }

  /** Sign a payload. `ttl` in seconds; omitted = no expiry. */
  sign(typ: TokenType, payload: Record<string, unknown>, ttl?: number): string {
    const iat = this.nowSec();
    const body = b64u(JSON.stringify({ ...payload, typ, iat, ...(ttl ? { exp: iat + ttl } : {}) }));
    return `${body}.${b64u(this.mac(`pt1.${body}`))}`;
  }

  /** Verify signature, type and expiry. Returns the payload or null. */
  verify<T extends Record<string, unknown>>(token: unknown, typ: TokenType): (T & { typ: TokenType; iat: number; exp?: number }) | null {
    if (typeof token !== "string" || token.length > 8192) return null;
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [body, sig] = parts as [string, string];
    const expected = this.mac(`pt1.${body}`);
    const got = Buffer.from(sig, "base64url");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    let payload: any;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!payload || typeof payload !== "object" || payload.typ !== typ) return null;
    if (typeof payload.exp === "number" && payload.exp <= this.nowSec()) return null;
    return payload;
  }

  /** Deterministic derived secret (e.g. a confidential client's client_secret). */
  derive(purpose: string, value: string): string {
    return b64u(this.mac(`${purpose}:${value}`));
  }
}

/** Best-effort single-use registry: remembers ids until their expiry. In memory, so lost on restart. */
export class UsedSet {
  private m = new Map<string, number>();
  constructor(private readonly nowSec: () => number) {}
  has(id: string) {
    const exp = this.m.get(id);
    return exp !== undefined && exp > this.nowSec();
  }
  add(id: string, exp: number) {
    const now = this.nowSec();
    if (this.m.size > 1000) for (const [k, e] of this.m) if (e <= now) this.m.delete(k);
    this.m.set(id, exp);
  }
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Redirect URIs a client may register: https anywhere, or http only on a loopback host. No fragments. */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/** Redirect URIs that skip the consent page: the code can only land with Claude or on the user's own machine. */
export function isTrustedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return true;
  return u.protocol === "https:" && (u.hostname === "claude.ai" || u.hostname === "claude.com") && u.pathname === "/api/mcp/auth_callback";
}

export function parseAllowlist(v: string | undefined): Set<string> {
  return new Set(
    (v ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
  );
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type GitHubOAuthConfig = {
  clientId: string;
  clientSecret: string;
  /** Overridable for tests. */
  authorizeUrl?: string;
  tokenUrl?: string;
  userUrl?: string;
  fetch?: typeof fetch;
};

export type ProviderOptions = {
  /** Public base URL, no trailing slash, e.g. https://mcp.example.com */
  publicUrl: string;
  sessionSecret: string;
  github: GitHubOAuthConfig;
  /** Read on every check so removing a user takes effect immediately. */
  allowedUsers: () => Set<string>;
  now?: () => number;
  log?: (m: string) => void;
};

type ClientBlob = { ru: string[]; n?: string; am: string; gt?: string[]; rt?: string[]; sc?: string };
type StateBlob = { cid: string; ru: string; cc: string; st?: string; sc: string[]; rs: string; nonce: string };
type CodeBlob = { cid: string; ru: string; cc: string; sub: string; sc: string[]; rs: string; jti: string };
type GrantBlob = { cid: string; sub: string; sc: string[]; rs: string; jti: string };

const MAX_REDIRECT_URIS = 10;

export class GitHubOAuthProvider implements OAuthServerProvider {
  readonly signer: Signer;
  readonly resource: string; // canonical protected resource: <publicUrl>/mcp
  readonly callbackUrl: string;
  private readonly usedCodes: UsedSet;
  private readonly usedRefresh: UsedSet;
  private readonly revoked: UsedSet;
  private readonly log: (m: string) => void;
  private readonly fetch: typeof fetch;

  constructor(private readonly o: ProviderOptions) {
    this.signer = new Signer(o.sessionSecret, o.now);
    this.resource = `${o.publicUrl}/mcp`;
    this.callbackUrl = `${o.publicUrl}/oauth/github/callback`;
    const nowSec = () => this.signer.nowSec();
    this.usedCodes = new UsedSet(nowSec);
    this.usedRefresh = new UsedSet(nowSec);
    this.revoked = new UsedSet(nowSec);
    this.log = o.log ?? (() => {});
    this.fetch = o.github.fetch ?? fetch;
  }

  isAllowed(login: string) {
    return this.o.allowedUsers().has(login.toLowerCase());
  }

  // ----------------------------------------------------------- clients
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => this.registerClient(client),
    };
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const c = this.signer.verify<ClientBlob>(clientId, "client");
    if (!c || !Array.isArray(c.ru)) return undefined;
    const confidential = c.am !== "none";
    return {
      client_id: clientId,
      client_id_issued_at: c.iat,
      redirect_uris: c.ru,
      client_name: c.n,
      token_endpoint_auth_method: c.am,
      grant_types: c.gt,
      response_types: c.rt,
      scope: c.sc,
      ...(confidential ? { client_secret: this.signer.derive("client_secret", clientId), client_secret_expires_at: 0 } : {}),
    };
  }

  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const ru = client.redirect_uris.map(String);
    if (ru.length === 0) throw new InvalidClientMetadataError("redirect_uris is required");
    if (ru.length > MAX_REDIRECT_URIS) throw new InvalidClientMetadataError(`At most ${MAX_REDIRECT_URIS} redirect_uris are allowed`);
    for (const u of ru) {
      if (u.length > 512 || !isAllowedRedirectUri(u))
        throw new InvalidClientMetadataError(`redirect_uri not allowed: must be https (or http on localhost/127.0.0.1), without a fragment`);
    }
    // The SDK token endpoint only reads client_secret from the body, so confidential clients use client_secret_post.
    const am = client.token_endpoint_auth_method === "none" ? "none" : "client_secret_post";
    const blob: ClientBlob = { ru, am };
    if (client.client_name) blob.n = client.client_name.slice(0, 100);
    if (client.grant_types) blob.gt = client.grant_types.slice(0, 5);
    if (client.response_types) blob.rt = client.response_types.slice(0, 3);
    if (client.scope) blob.sc = client.scope.slice(0, 200);
    const clientId = this.signer.sign("client", blob);
    this.log(`registered client "${blob.n ?? "(unnamed)"}" (${am})`);
    return this.getClient(clientId)!;
  }

  // --------------------------------------------------------- authorize
  /** Canonicalise the RFC 8707 `resource` parameter. We accept <publicUrl>/mcp and <publicUrl> itself. */
  private checkResource(resource: URL | string | undefined): string {
    if (resource === undefined) return this.resource;
    const norm = (s: string) => s.replace(/#.*$/, "").replace(/\/+$/, "");
    const r = norm(String(resource));
    if (r === norm(this.resource) || r === norm(this.o.publicUrl)) return this.resource;
    throw new InvalidTargetError(`Unknown resource. This server's resource is ${this.resource}`);
  }

  githubAuthorizeUrl(state: string) {
    const u = new URL(this.o.github.authorizeUrl ?? "https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", this.o.github.clientId);
    u.searchParams.set("redirect_uri", this.callbackUrl);
    u.searchParams.set("scope", "read:user");
    u.searchParams.set("state", state);
    u.searchParams.set("allow_signup", "false");
    return u.href;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // The SDK already checked that redirectUri is one of the client's registered URIs (loopback: any port).
    // Re-check our scheme policy in case a client was registered under an older policy.
    if (!isAllowedRedirectUri(params.redirectUri)) throw new InvalidClientMetadataError("redirect_uri not allowed");
    const rs = this.checkResource(params.resource);
    const st: StateBlob = {
      cid: client.client_id,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      sc: (params.scopes ?? []).slice(0, 10),
      rs,
      nonce: randomBytes(9).toString("base64url"),
    };
    if (params.state !== undefined) st.st = params.state;
    const url = this.githubAuthorizeUrl(this.signer.sign("ghstate", st, STATE_TTL));
    if (isTrustedRedirectUri(params.redirectUri)) {
      res.redirect(302, url);
      return;
    }
    // Any other redirect target: ask first, so a link from a third party can't silently mint a token
    // for a client it registered (the GitHub step may auto-approve for a returning user).
    const host = new URL(params.redirectUri).host;
    htmlPage(
      res,
      200,
      "Sign in to Prayer Tower",
      `<p><strong>${escapeHtml(client.client_name ?? "An application")}</strong> wants to manage Prayer Tower prayer requests on your behalf.</p>
<p>After you sign in with GitHub you will be sent to <code>${escapeHtml(host)}</code>. Continue only if you started this from an app you trust.</p>
<p><a class="btn" href="${escapeHtml(url)}">Continue with GitHub</a></p>`,
    );
  }

  /** GET /oauth/github/callback */
  async githubCallback(req: Request, res: Response): Promise<void> {
    const q = req.query as Record<string, unknown>;
    const st = this.signer.verify<StateBlob>(q.state, "ghstate");
    if (!st) {
      htmlPage(res, 400, "Sign-in link expired", "<p>This sign-in link is invalid or has expired. Go back to Claude and try connecting again.</p>");
      return;
    }
    const back = (params: Record<string, string>) => {
      const u = new URL(st.ru);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (st.st !== undefined) u.searchParams.set("state", st.st);
      res.redirect(302, u.href);
    };
    if (typeof q.error === "string") {
      back({ error: "access_denied", error_description: "GitHub sign-in was cancelled" });
      return;
    }
    if (typeof q.code !== "string" || !q.code) {
      back({ error: "invalid_request", error_description: "Missing code from GitHub" });
      return;
    }

    let login: string;
    try {
      login = await this.githubLogin(q.code);
    } catch (e) {
      this.log(`github sign-in failed: ${(e as Error).message}`);
      back({ error: "server_error", error_description: "GitHub sign-in failed" });
      return;
    }

    if (!this.isAllowed(login)) {
      this.log(`github sign-in denied: ${login}`);
      htmlPage(
        res,
        403,
        "Not authorised",
        `<p>You are signed in to GitHub as <strong>${escapeHtml(login)}</strong>, but this account is not allowed to use the Prayer Tower connector.</p>
<p>Ask the Prayer Tower administrator to add your GitHub username, then try connecting again.</p>`,
      );
      return;
    }

    const code: CodeBlob = { cid: st.cid, ru: st.ru, cc: st.cc, sub: login, sc: st.sc, rs: st.rs, jti: randomBytes(12).toString("base64url") };
    this.log(`github sign-in ok: ${login}`);
    back({ code: this.signer.sign("code", code, CODE_TTL) });
  }

  /** Exchange a GitHub OAuth code for the user's login. The GitHub token is used once and discarded. */
  private async githubLogin(code: string): Promise<string> {
    const tr = await this.fetch(this.o.github.tokenUrl ?? "https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "prayer-tower-mcp" },
      body: new URLSearchParams({
        client_id: this.o.github.clientId,
        client_secret: this.o.github.clientSecret,
        code,
        redirect_uri: this.callbackUrl,
      }).toString(),
    });
    const tj = (await tr.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!tr.ok || !tj.access_token) throw new Error(`token exchange failed (${tr.status} ${tj.error ?? ""})`);
    const ur = await this.fetch(this.o.github.userUrl ?? "https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tj.access_token}`,
        "User-Agent": "prayer-tower-mcp",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const uj = (await ur.json().catch(() => ({}))) as { login?: string };
    if (!ur.ok || typeof uj.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(uj.login)) throw new Error(`user lookup failed (${ur.status})`);
    return uj.login;
  }

  // ------------------------------------------------------------- codes
  private readCode(client: OAuthClientInformationFull, code: string): CodeBlob & { exp?: number } {
    const c = this.signer.verify<CodeBlob>(code, "code");
    if (!c) throw new InvalidGrantError("Invalid or expired authorization code");
    if (c.cid !== client.client_id) throw new InvalidGrantError("Authorization code was issued to another client");
    if (this.usedCodes.has(c.jti)) throw new InvalidGrantError("Authorization code has already been used");
    return c;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.readCode(client, code).cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // PKCE was verified by the SDK token handler against challengeForAuthorizationCode().
    const c = this.readCode(client, code);
    if (redirectUri !== undefined && redirectUri !== c.ru) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (resource !== undefined && this.checkResource(resource) !== c.rs) throw new InvalidTargetError("resource does not match the authorization request");
    this.usedCodes.add(c.jti, c.exp ?? this.signer.nowSec() + CODE_TTL);
    if (!this.isAllowed(c.sub)) throw new InvalidGrantError("User is no longer allowed");
    return this.issue({ cid: c.cid, sub: c.sub, sc: c.sc, rs: c.rs });
  }

  private issue(g: Omit<GrantBlob, "jti">): OAuthTokens {
    const jti = () => randomBytes(12).toString("base64url");
    return {
      access_token: this.signer.sign("access", { ...g, jti: jti() }, ACCESS_TTL),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: this.signer.sign("refresh", { ...g, jti: jti() }, REFRESH_TTL),
      ...(g.sc.length ? { scope: g.sc.join(" ") } : {}),
    };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const r = this.signer.verify<GrantBlob>(refreshToken, "refresh");
    if (!r) throw new InvalidGrantError("Invalid or expired refresh token");
    if (r.cid !== client.client_id) throw new InvalidGrantError("Refresh token was issued to another client");
    if (this.usedRefresh.has(r.jti) || this.revoked.has(r.jti)) throw new InvalidGrantError("Refresh token has already been used");
    if (scopes && scopes.some((s) => !r.sc.includes(s))) throw new InvalidScopeError("Requested scope exceeds the original grant");
    if (resource !== undefined && this.checkResource(resource) !== r.rs) throw new InvalidTargetError("resource does not match the original grant");
    if (!this.isAllowed(r.sub)) throw new InvalidGrantError("User is no longer allowed");
    // Rotation: this refresh token is spent; a new one is issued with the new access token.
    this.usedRefresh.add(r.jti, r.exp ?? this.signer.nowSec() + REFRESH_TTL);
    return this.issue({ cid: r.cid, sub: r.sub, sc: scopes ?? r.sc, rs: r.rs });
  }

  // ------------------------------------------------------------ tokens
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const a = this.signer.verify<GrantBlob>(token, "access");
    if (!a || typeof a.sub !== "string") throw new InvalidTokenError("Invalid or expired access token");
    if (this.revoked.has(a.jti)) throw new InvalidTokenError("Access token has been revoked");
    if (!this.isAllowed(a.sub)) throw new InvalidTokenError("User is not allowed");
    return {
      token,
      clientId: a.cid,
      scopes: a.sc ?? [],
      expiresAt: a.exp,
      resource: new URL(a.rs),
      extra: { login: a.sub },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    for (const typ of ["access", "refresh"] as const) {
      const t = this.signer.verify<GrantBlob>(request.token, typ);
      if (t && t.cid === client.client_id) this.revoked.add(t.jti, t.exp ?? this.signer.nowSec() + REFRESH_TTL);
    }
  }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export function htmlPage(res: Response, status: number, title: string, bodyHtml: string) {
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
    })
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1f2937}
h1{font-size:1.4rem}.btn{display:inline-block;padding:.6rem 1rem;background:#111827;color:#fff;border-radius:.4rem;text-decoration:none}
code{background:#f3f4f6;padding:.1rem .3rem;border-radius:.2rem}</style></head>
<body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`);
}
