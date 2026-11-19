// Octokit-backed GitHubClient.
import { Octokit } from "@octokit/rest";
import type { GitHubClient } from "./store.js";

export function octokitClient(token: string, repoFull: string): GitHubClient {
  const [owner, repo] = repoFull.split("/");
  if (!owner || !repo) throw new Error(`PRAYER_TOWER_REPO must look like "owner/name" (got "${repoFull}")`);
  const gh = new Octokit({ auth: token, userAgent: "prayer-tower-mcp" });
  return {
    async getBranchSha(branch) {
      const { data } = await gh.rest.repos.getBranch({ owner, repo, branch });
      return data.commit.sha;
    },
    async getFile(path, ref) {
      const { data } = await gh.rest.repos.getContent({ owner, repo, path, ref });
      if (Array.isArray(data) || data.type !== "file") throw new Error(`${path} is not a file in ${repoFull}`);
      let content: string;
      if ("content" in data && data.content) content = Buffer.from(data.content, "base64").toString("utf8");
      else {
        // Files > 1 MB come back without inline content; fetch the blob.
        const blob = await gh.rest.git.getBlob({ owner, repo, file_sha: data.sha });
        content = Buffer.from(blob.data.content, "base64").toString("utf8");
      }
      return { content, sha: data.sha };
    },
    async createBranch(name, fromSha) {
      await gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${name}`, sha: fromSha });
    },
    async putFile({ path, branch, content, message, sha }) {
      const { data } = await gh.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        branch,
        message,
        sha,
        content: Buffer.from(content, "utf8").toString("base64"),
      });
      return { commitSha: data.commit.sha ?? "", commitUrl: data.commit.html_url ?? "" };
    },
    async createPull({ title, body, head, base }) {
      const { data } = await gh.rest.pulls.create({ owner, repo, title, body, head, base });
      return { url: data.html_url, number: data.number };
    },
  };
}
