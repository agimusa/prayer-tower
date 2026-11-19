// Storage backends. LocalStore edits a checkout on disk; GitHubStore keeps an in-memory
// draft + ops log and publishes through the GitHub Contents/Pulls API.
import { promises as fs } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { validateRoot, type Root } from "./schema.js";
import { applyOp, commitMessage, OpError, replay, validate, type Op } from "./ops.js";
import { diffRoots, formatDiff, serialize, type RootDiff } from "./view.js";

export type PublishOptions = {
  message?: string;
  direct?: boolean;
  confirm?: boolean;
  /** GitHub login of the signed-in user (hosted mode). Appended to the commit message trailer and the PR branch name. */
  actor?: string;
};

export type PublishResult = {
  mode: "local" | "pr" | "direct";
  published: boolean;
  message: string;
  url?: string;
  branch?: string;
  commit_message?: string;
  diff?: string;
};

export interface Store {
  readonly mode: "local" | "github";
  describe(): string;
  /** Current working state (draft in GitHub mode, file on disk in local mode). */
  current(): Promise<Root>;
  /** Snapshot changes are measured against (server start or last publish). */
  base(): Root;
  /** Ops applied since the base. */
  pendingOps(): Op[];
  /** Apply a pre-built op (built against `current()`), persist, return the new state. */
  apply(op: Op): Promise<Root>;
  diff(): Promise<RootDiff>;
  publish(opts: PublishOptions): Promise<PublishResult>;
  discard(): Promise<string>;
}

const parse = (text: string, where: string): Root => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new OpError(`${where} is not valid JSON: ${(e as Error).message}`);
  }
  validateRoot(json); // throws readable ValidationError
  // Keep the raw object (not zod's output) so key order and formatting round-trip exactly.
  return json as Root;
};

// ---------------------------------------------------------------------------
// Local mode
// ---------------------------------------------------------------------------

export class LocalStore implements Store {
  readonly mode = "local" as const;
  private baseRoot!: Root;
  private ops: Op[] = [];
  private eol = "\n";

  private constructor(readonly filePath: string) {}

  static async open(filePath: string): Promise<LocalStore> {
    const s = new LocalStore(filePath);
    s.baseRoot = await s.read();
    return s;
  }

  describe() {
    return `local mode: editing ${this.filePath} directly (publish does not run git)`;
  }

  private async read(): Promise<Root> {
    const text = await fs.readFile(this.filePath, "utf8");
    this.eol = text.includes("\r\n") ? "\r\n" : "\n";
    return parse(text, this.filePath);
  }

  async current() {
    return this.read();
  }
  base() {
    return this.baseRoot;
  }
  pendingOps() {
    return [...this.ops];
  }

  async apply(op: Op): Promise<Root> {
    const next = validate(applyOp(await this.read(), op));
    await atomicWrite(this.filePath, serialize(next, this.eol));
    this.ops.push(op);
    return next;
  }

  async diff() {
    return diffRoots(this.baseRoot, await this.read());
  }

  async publish(opts: PublishOptions): Promise<PublishResult> {
    const cur = await this.read();
    const d = diffRoots(this.baseRoot, cur);
    const msg = commitMessage(this.ops, opts.message, opts.actor);
    const text = d.has_changes ? formatDiff(d) : "No changes since server start / last publish.";
    this.baseRoot = cur;
    this.ops = [];
    return {
      mode: "local",
      published: false,
      diff: text,
      commit_message: d.has_changes ? msg : undefined,
      message:
        `local mode: ${this.filePath} has already been written. Review and commit with git yourself, e.g.\n` +
        `  git -C "${dirname(dirname(this.filePath))}" diff -- data/prayers.json\n` +
        `  git -C "${dirname(dirname(this.filePath))}" commit -am "<message>" && git push\n` +
        `(The change baseline has been reset.)`,
    };
  }

  async discard() {
    this.ops = [];
    return (
      "local mode: edits were already written to disk and cannot be undone by the server. " +
      `To revert, run: git -C "${dirname(dirname(this.filePath))}" checkout -- ${basename(dirname(this.filePath))}/${basename(this.filePath)}`
    );
  }
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// GitHub mode
// ---------------------------------------------------------------------------

/** The subset of GitHub we need; implemented with Octokit in github.ts and faked in tests. */
export interface GitHubClient {
  /** Head commit sha of a branch. */
  getBranchSha(branch: string): Promise<string>;
  /** File content (utf8) and blob sha at a ref (branch or commit sha). */
  getFile(path: string, ref: string): Promise<{ content: string; sha: string }>;
  createBranch(name: string, fromSha: string): Promise<void>;
  /** Create/update a file. Must throw an error with `status: 409` (or 422 sha mismatch) on a stale blob sha. */
  putFile(args: { path: string; branch: string; content: string; message: string; sha: string }): Promise<{
    commitSha: string;
    commitUrl: string;
  }>;
  createPull(args: { title: string; body: string; head: string; base: string }): Promise<{ url: string; number: number }>;
}

export type GitHubStoreOptions = {
  client: GitHubClient;
  repo: string; // owner/name
  branch: string;
  file: string;
  publishMode: "pr" | "direct";
  now?: () => Date;
};

export const isShaConflict = (e: unknown) => {
  const status = (e as { status?: number })?.status;
  const msg = String((e as Error)?.message ?? "");
  return status === 409 || (status === 422 && /sha/i.test(msg));
};

export function branchName(d: Date, actor?: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  // Hosted mode: several users may publish in the same second, so suffix the login.
  const who = actor ? "-" + actor.toLowerCase().replace(/[^a-z0-9-]/g, "-") : "";
  return `prayer-update-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${who}`;
}

export class GitHubStore implements Store {
  readonly mode = "github" as const;
  private baseRoot!: Root;
  private draft!: Root;
  private ops: Op[] = [];

  private constructor(private readonly o: GitHubStoreOptions) {}

  static async open(o: GitHubStoreOptions): Promise<GitHubStore> {
    const s = new GitHubStore(o);
    await s.reset();
    return s;
  }

  describe() {
    return `GitHub mode: ${this.o.repo}@${this.o.branch}:${this.o.file} (default publish: ${this.o.publishMode === "direct" ? "direct commit, requires confirm" : "pull request"}); ${this.ops.length} unpublished change(s)`;
  }

  private async fetchLatest(): Promise<{ root: Root; sha: string; commit: string }> {
    const commit = await this.o.client.getBranchSha(this.o.branch);
    const f = await this.o.client.getFile(this.o.file, commit);
    return { root: parse(f.content, `${this.o.repo}:${this.o.file}`), sha: f.sha, commit };
  }

  private async reset() {
    const { root } = await this.fetchLatest();
    this.baseRoot = root;
    this.draft = root;
    this.ops = [];
  }

  async current() {
    return this.draft;
  }
  base() {
    return this.baseRoot;
  }
  pendingOps() {
    return [...this.ops];
  }

  async apply(op: Op) {
    this.draft = validate(applyOp(this.draft, op));
    this.ops.push(op);
    return this.draft;
  }

  async diff() {
    return diffRoots(this.baseRoot, this.draft);
  }

  async publish(opts: PublishOptions): Promise<PublishResult> {
    if (this.ops.length === 0) return { mode: "pr", published: false, message: "Nothing to publish: no pending changes." };
    const direct = opts.direct ?? this.o.publishMode === "direct";
    if (direct && opts.confirm !== true)
      throw new OpError(
        "Direct publish commits straight to " +
          `${this.o.repo}@${this.o.branch} and updates the live site immediately. ` +
          "Show the user preview_changes, get their explicit OK, then call publish again with direct: true AND confirm: true. " +
          "Or call publish with direct: false to open a pull request instead.",
      );
    const message = commitMessage(this.ops, opts.message, opts.actor);
    const title = message.split("\n")[0]!;
    const now = (this.o.now ?? (() => new Date()))();

    const attempt = async () => {
      const latest = await this.fetchLatest();
      const next = replay(latest.root, this.ops);
      const content = serialize(next);
      return { latest, next, content };
    };

    let prepared = await attempt();
    let result: PublishResult;
    if (direct) {
      let put;
      try {
        put = await this.o.client.putFile({ path: this.o.file, branch: this.o.branch, content: prepared.content, message, sha: prepared.latest.sha });
      } catch (e) {
        if (!isShaConflict(e)) throw e;
        prepared = await attempt(); // someone else committed meanwhile: refetch + replay + retry once
        put = await this.o.client.putFile({ path: this.o.file, branch: this.o.branch, content: prepared.content, message, sha: prepared.latest.sha });
      }
      result = {
        mode: "direct",
        published: true,
        url: put.commitUrl,
        commit_message: message,
        message: `Committed to ${this.o.repo}@${this.o.branch}. GitHub Pages usually updates the site within a minute or two.`,
      };
    } else {
      const branch = branchName(now, opts.actor);
      await this.o.client.createBranch(branch, prepared.latest.commit);
      await this.o.client.putFile({ path: this.o.file, branch, content: prepared.content, message, sha: prepared.latest.sha });
      const pr = await this.o.client.createPull({
        title,
        head: branch,
        base: this.o.branch,
        body: `${message}\n\n${formatDiff(diffRoots(prepared.latest.root, prepared.next))}`,
      });
      result = {
        mode: "pr",
        published: true,
        url: pr.url,
        branch,
        commit_message: message,
        message: `Opened pull request #${pr.number}. The site updates after it is merged into ${this.o.branch}.`,
      };
    }
    // Clear the log and rebase onto what we just published.
    this.baseRoot = prepared.next;
    this.draft = prepared.next;
    this.ops = [];
    return result;
  }

  async discard() {
    const n = this.ops.length;
    await this.reset();
    return `Discarded ${n} unpublished change(s); draft reset to the latest ${this.o.repo}@${this.o.branch}.`;
  }
}
