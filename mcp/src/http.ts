#!/usr/bin/env node
// Hosted entry point: MCP over Streamable HTTP (stateless) behind a GitHub-backed OAuth 2.1 server,
// for use as a claude.ai custom connector. Run with `node dist/http.js` (listens on $PORT, default 3000).
//
//   GET  /healthz                                  -> {ok, version, mode}
//   POST /mcp                                      -> MCP (bearer token required)
//   /.well-known/oauth-authorization-server         \
//   /.well-known/oauth-protected-resource[/mcp]      |  SDK mcpAuthRouter + GitHubOAuthProvider
//   /register /authorize /token /revoke             /
//   GET  /oauth/github/callback                    -> GitHub sign-in return, allowlist check
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { octokitClient } from "./github.js";
import { GitHubOAuthProvider, MIN_SECRET_LENGTH, htmlPage, parseAllowlist, type GitHubOAuthConfig } from "./oauth.js";
import { createServer, makeExclusive, VERSION, type Exclusive } from "./server.js";
import { GitHubStore, LocalStore, type Store } from "./store.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export class HttpConfigError extends Error {}

export type HttpConfig = {
  publicUrl: string;
  sessionSecret: string;
  github: { clientId: string; clientSecret: string };
  store: Config;
  port: number;
};

/** Validate the hosted-mode environment. Throws HttpConfigError listing every problem. */
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const get = (k: string) => env[k]?.trim() || "";
  const required = ["PUBLIC_URL", "SESSION_SECRET", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET", "ALLOWED_GITHUB_USERS"];
  if (!get("PRAYER_TOWER_REPO_PATH")) required.push("GITHUB_TOKEN");
  const problems: string[] = [];
  const missing = required.filter((k) => !get(k));
  if (missing.length) problems.push(`Missing required environment variable(s): ${missing.join(", ")}`);

  const secret = get("SESSION_SECRET");
  if (secret && secret.length < MIN_SECRET_LENGTH)
    problems.push(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters (e.g. run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")`);

  let publicUrl = get("PUBLIC_URL").replace(/\/+$/, "");
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) problems.push("PUBLIC_URL must use https:// (http:// is allowed only for localhost)");
      if (u.pathname !== "/" || u.search || u.hash) problems.push("PUBLIC_URL must be an origin only, e.g. https://mcp.example.com (no path, query or fragment)");
      publicUrl = u.origin;
    } catch {
      problems.push(`PUBLIC_URL is not a valid URL: ${publicUrl}`);
    }
  }
  if (get("ALLOWED_GITHUB_USERS") && parseAllowlist(get("ALLOWED_GITHUB_USERS")).size === 0)
    problems.push("ALLOWED_GITHUB_USERS must list at least one GitHub username (comma-separated)");

  let store: Config | undefined;
  if (!missing.includes("GITHUB_TOKEN")) {
    try {
      store = loadConfig(env);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      problems.push(e.message.split("\n")[0]!);
    }
  }
  const port = Number(get("PORT") || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push(`PORT must be a port number (got "${get("PORT")}")`);

  if (problems.length || !store)
    throw new HttpConfigError(
      `prayer-tower-mcp (hosted) cannot start:\n  - ${problems.join("\n  - ")}\n\n` +
        "Required: PUBLIC_URL, SESSION_SECRET (>= 32 chars), GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, ALLOWED_GITHUB_USERS, " +
        "and GITHUB_TOKEN (unless PRAYER_TOWER_REPO_PATH is set for local mode). Optional: PORT, PRAYER_TOWER_REPO, PRAYER_TOWER_BRANCH, PRAYER_TOWER_FILE, PRAYER_TOWER_PUBLISH_MODE.",
    );
  return {
    publicUrl,
    sessionSecret: secret,
    github: { clientId: get("GITHUB_OAUTH_CLIENT_ID"), clientSecret: get("GITHUB_OAUTH_CLIENT_SECRET") },
    store,
    port,
  };
}

/**
 * Store per signed-in user. GitHub mode: each login gets its own in-memory draft (GitHubStore), created
 * lazily on first use and lost on restart. Local mode (tests/dev): one shared LocalStore.
 */
export function storeFactory(config: Config, open?: { local?: typeof LocalStore.open; github?: typeof GitHubStore.open }) {
  if (config.mode === "local") {
    let shared: Promise<Store> | undefined;
    return (_login: string): Promise<Store> => (shared ??= (open?.local ?? LocalStore.open)(config.filePath));
  }
  const stores = new Map<string, Promise<Store>>();
  return (login: string): Promise<Store> => {
    const key = login.toLowerCase();
    let p = stores.get(key);
    if (!p) {
      p = (open?.github ?? GitHubStore.open)({
        client: octokitClient(config.token, config.repo),
        repo: config.repo,
        branch: config.branch,
        file: config.file,
        publishMode: config.publishMode,
      });
      stores.set(key, p);
      p.catch(() => stores.delete(key)); // let the next request retry
    }
    return p;
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export type HttpAppOptions = {
  /** Origin, no trailing slash, e.g. https://mcp.example.com */
  publicUrl: string;
  sessionSecret: string;
  github: GitHubOAuthConfig;
  /** Re-read on every request; default: process.env.ALLOWED_GITHUB_USERS. */
  allowedUsers?: () => Set<string>;
  mode: "local" | "github";
  storeFor: (login: string) => Promise<Store>;
  now?: () => number;
  log?: (m: string) => void;
  /** Disable the SDK / callback rate limiters (tests). Default true. */
  rateLimit?: boolean;
};

const jsonRpcError = (res: Response, status: number, message: string, code = -32000) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

export function createHttpApp(o: HttpAppOptions) {
  const log = o.log ?? ((m: string) => console.log(`[prayer-tower] ${m}`));
  const publicUrl = o.publicUrl.replace(/\/+$/, "");
  const provider = new GitHubOAuthProvider({
    publicUrl,
    sessionSecret: o.sessionSecret, // throws if too short
    github: o.github,
    allowedUsers: o.allowedUsers ?? (() => parseAllowlist(process.env.ALLOWED_GITHUB_USERS)),
    now: o.now,
    log,
  });
  const resourceUrl = new URL(provider.resource);
  const limits = o.rateLimit === false ? { rateLimit: false as const } : {};

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Hostinger terminates TLS in a reverse proxy

  // Minimal security headers everywhere; HTML pages add CSP + frame denial in htmlPage().
  app.use((req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    // Access log: method, path (never the query string, which carries codes/state), status, login.
    // Capture the path now: mounted routers rewrite req.url while they run.
    const path = req.path;
    res.on("finish", () => {
      const login = (req as Request & { auth?: { extra?: { login?: unknown } } }).auth?.extra?.login;
      log(`${req.method} ${path} ${res.statusCode}${login ? ` @${login}` : ""}`);
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ ok: true, version: VERSION, mode: o.mode });
  });

  app.get("/", (_req, res) => {
    htmlPage(
      res,
      200,
      "Prayer Tower MCP",
      `<p>This is the Prayer Tower MCP server. Add it in Claude as a custom connector with the URL <code>${provider.resource}</code>.</p>`,
    );
  });

  // OAuth authorization server (+ AS and path-suffixed protected-resource metadata).
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(publicUrl),
      resourceServerUrl: resourceUrl,
      resourceName: "Prayer Tower",
      authorizationOptions: { ...limits },
      tokenOptions: { ...limits },
      revocationOptions: { ...limits },
      // Secrets are derived statelessly from client_id, so they cannot expire.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0, ...limits },
    }),
  );
  // Root protected-resource metadata as well (some clients look here first).
  app.use(
    "/.well-known/oauth-protected-resource",
    metadataHandler({ resource: resourceUrl.href, authorization_servers: [new URL(publicUrl).href], resource_name: "Prayer Tower" }),
  );

  const callback = express.Router();
  if (o.rateLimit !== false) callback.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));
  callback.get("/", (req, res, next) => {
    provider.githubCallback(req, res).catch(next);
  });
  app.use("/oauth/github/callback", callback);

  // ---------------------------------------------------------------- /mcp
  const locks = new WeakMap<Store, Exclusive>();
  const lockFor = (s: Store) => {
    let l = locks.get(s);
    if (!l) locks.set(s, (l = makeExclusive()));
    return l;
  };
  const mcpCors = cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
    exposedHeaders: ["WWW-Authenticate", "Mcp-Session-Id", "Mcp-Protocol-Version"],
    maxAge: 600,
  });
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    expectedResource: resourceUrl,
  });

  app.options("/mcp", mcpCors);
  app.post("/mcp", mcpCors, bearer, express.json({ limit: "100kb" }), async (req, res) => {
    const login = String((req as Request & { auth?: { extra?: { login?: unknown } } }).auth?.extra?.login ?? "");
    let server: ReturnType<typeof createServer> | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const store = await o.storeFor(login);
      server = createServer(store, { log: (m) => log(`@${login}: ${m}`), actor: login, hosted: true, exclusive: lockFor(store) });
      // Stateless: a fresh server + transport per request, so restarts never break a "session".
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport?.close();
        void server?.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log(`mcp error @${login}: ${scrub(String((e as Error)?.message ?? e))}`);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error", -32603);
    }
  });
  app.all("/mcp", mcpCors, (_req, res) => {
    res.set("Allow", "POST, OPTIONS");
    jsonRpcError(res, 405, "Method not allowed. This server is stateless: use POST.");
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Body-parser and other errors: JSON, never a stack trace.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; statusCode?: number; type?: string; message?: string };
    const status = e.status ?? e.statusCode ?? 500;
    if (status >= 500) log(`error ${req.method} ${req.path}: ${scrub(String(e.message ?? err))}`);
    if (res.headersSent) return;
    if (req.path === "/mcp") jsonRpcError(res, status, status === 413 ? "Request body too large" : status < 500 ? "Bad request" : "Internal server error", status < 500 ? -32700 : -32603);
    else res.status(status).json({ error: status < 500 ? "invalid_request" : "server_error" });
  });

  return { app, provider };
}

/** Strip anything that looks like a GitHub token from log text. */
const scrub = (s: string) => s.replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "$1***");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const log = (m: string) => console.log(`[prayer-tower] ${m}`);
  let cfg: HttpConfig;
  try {
    cfg = loadHttpConfig(env);
  } catch (e) {
    if (e instanceof HttpConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  const { app } = createHttpApp({
    publicUrl: cfg.publicUrl,
    sessionSecret: cfg.sessionSecret,
    github: cfg.github,
    allowedUsers: () => parseAllowlist(env.ALLOWED_GITHUB_USERS),
    mode: cfg.store.mode,
    storeFor: storeFactory(cfg.store),
    log,
  });
  const server = app.listen(cfg.port, () => {
    const where = cfg.store.mode === "local" ? `local file ${cfg.store.filePath}` : `${cfg.store.repo}@${cfg.store.branch}:${cfg.store.file}`;
    log(`v${VERSION} listening on port ${cfg.port}; MCP endpoint ${cfg.publicUrl}/mcp; storage: ${where}`);
  });
  const stop = () => {
    log("shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(`[prayer-tower] fatal: ${scrub(String((e as Error)?.stack ?? e))}`);
    process.exit(1);
  });
}
