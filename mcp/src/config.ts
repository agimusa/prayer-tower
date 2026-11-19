// Environment -> store configuration.
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type Config =
  | { mode: "local"; filePath: string }
  | {
      mode: "github";
      token: string;
      repo: string;
      branch: string;
      file: string;
      publishMode: "pr" | "direct";
    };

export class ConfigError extends Error {}

export const USAGE = `prayer-tower-mcp needs one of two configurations (set as env vars in your MCP client config):

  GitHub mode (recommended; publishes to the live site via PR or direct commit):
    GITHUB_TOKEN=<fine-grained PAT with Contents + Pull requests read/write on agimusa/prayer-tower>
    PRAYER_TOWER_REPO=agimusa/prayer-tower   (optional, default)
    PRAYER_TOWER_BRANCH=main                 (optional, default)
    PRAYER_TOWER_FILE=data/prayers.json      (optional, default)
    PRAYER_TOWER_PUBLISH_MODE=pr|direct      (optional, default pr; direct still needs confirm:true)

  Local mode (edits a git checkout on disk; you commit/push yourself):
    PRAYER_TOWER_REPO_PATH=<absolute path to your prayer-tower checkout>

If both are set, local mode wins.`;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = env.PRAYER_TOWER_FILE?.trim() || "data/prayers.json";
  const repoPath = env.PRAYER_TOWER_REPO_PATH?.trim();
  if (repoPath) {
    const filePath = isAbsolute(file) ? file : resolve(repoPath, file);
    if (!existsSync(filePath)) throw new ConfigError(`PRAYER_TOWER_REPO_PATH is set but ${filePath} does not exist.\n\n${USAGE}`);
    return { mode: "local", filePath };
  }
  const token = env.GITHUB_TOKEN?.trim();
  if (token) {
    const pm = (env.PRAYER_TOWER_PUBLISH_MODE?.trim().toLowerCase() || "pr") as string;
    if (pm !== "pr" && pm !== "direct") throw new ConfigError(`PRAYER_TOWER_PUBLISH_MODE must be "pr" or "direct" (got "${pm}")`);
    return {
      mode: "github",
      token,
      repo: env.PRAYER_TOWER_REPO?.trim() || "agimusa/prayer-tower",
      branch: env.PRAYER_TOWER_BRANCH?.trim() || "main",
      file,
      publishMode: pm,
    };
  }
  throw new ConfigError(`No configuration found.\n\n${USAGE}`);
}
