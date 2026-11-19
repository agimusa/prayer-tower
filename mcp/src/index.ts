#!/usr/bin/env node
// stdio entry point. stdout is reserved for the MCP protocol; all logs go to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { octokitClient } from "./github.js";
import { createServer } from "./server.js";
import { GitHubStore, LocalStore, type Store } from "./store.js";

const log = (m: string) => process.stderr.write(`[prayer-tower] ${m}\n`);

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      log(e.message);
      process.exit(2);
    }
    throw e;
  }

  let store: Store;
  if (config.mode === "local") {
    store = await LocalStore.open(config.filePath);
  } else {
    store = await GitHubStore.open({
      client: octokitClient(config.token, config.repo),
      repo: config.repo,
      branch: config.branch,
      file: config.file,
      publishMode: config.publishMode,
    });
  }
  log(store.describe());

  const server = createServer(store, { log });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  // Never print the token: Octokit errors don't include it, but strip anything token-like defensively.
  const msg = String((e as Error)?.stack ?? e).replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "$1***");
  log(`fatal: ${msg}`);
  process.exit(1);
});
