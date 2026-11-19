import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyOp, buildAddRequest, buildUpdateRequest, findRequest, resolveSlide, type OpContext } from "../src/ops.js";
import { validateRoot, type Root } from "../src/schema.js";
import { branchName, GitHubStore, LocalStore, type GitHubClient } from "../src/store.js";
import { serialize } from "../src/view.js";
import { loadConfig } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const realFile = resolve(here, "../../data/prayers.json");
const realText = readFileSync(realFile, "utf8");
const ctx: OpContext = { now: () => new Date("2026-11-20T10:00:00.000Z") };

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "prayer-tower-test-"));
  tmps.push(dir);
  mkdirSync(join(dir, "data"));
  copyFileSync(realFile, join(dir, "data", "prayers.json"));
  return join(dir, "data", "prayers.json");
}

const samuelLike = {
  name: { en: "Daniel Test", te: "డేనియల్ టెస్ట్" },
  note: { en: "(Twinkle Amjala's cousin)", te: "(ట్వింకిల్ అమ్జాల గారి బంధువు)" },
  items: [
    { en: "Healing from diabetes-related complications.", te: "మధుమేహ సంబంధిత సమస్యల నుండి స్వస్థత." },
    { en: "Complete recovery and strength.", te: "సంపూర్ణంగా కోలుకోవడం మరియు బలం." },
  ],
};

describe("config", () => {
  it("chooses local, github, or fails with usage", () => {
    const file = tempRepo();
    const repo = dirname(dirname(file));
    expect(loadConfig({ PRAYER_TOWER_REPO_PATH: repo, GITHUB_TOKEN: "x" })).toEqual({ mode: "local", filePath: file });
    expect(loadConfig({ GITHUB_TOKEN: "x" })).toMatchObject({ mode: "github", repo: "agimusa/prayer-tower", branch: "main", file: "data/prayers.json", publishMode: "pr" });
    expect(loadConfig({ GITHUB_TOKEN: "x", PRAYER_TOWER_PUBLISH_MODE: "direct" })).toMatchObject({ publishMode: "direct" });
    expect(() => loadConfig({})).toThrow(/GITHUB_TOKEN[\s\S]*PRAYER_TOWER_REPO_PATH/);
    expect(() => loadConfig({ PRAYER_TOWER_REPO_PATH: join(repo, "nope") })).toThrow(/does not exist/);
  });
});

describe("LocalStore", () => {
  it("writes a Samuel-Newton-like request to disk atomically and the file still validates", async () => {
    const file = tempRepo();
    const store = await LocalStore.open(file);
    const op = buildAddRequest(await store.current(), samuelLike, ctx);
    await store.apply(op);
    const text = readFileSync(file, "utf8");
    const disk = validateRoot(JSON.parse(text));
    const added = resolveSlide(disk, "additional").requests.at(-1)!;
    expect(added).toMatchObject({ name: samuelLike.name, note: samuelLike.note, items: samuelLike.items, te_status: "auto", source: "mcp" });
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain("డేనియల్ టెస్ట్"); // literal Telugu, not \u escapes
    // Only the new request changed: everything before it is byte-identical.
    const anchor = realText.lastIndexOf("\n      ]\n    },\n    {\n      \"id\": \"founders\"");
    expect(anchor).toBeGreaterThan(0);
    expect(text.startsWith(realText.slice(0, realText.indexOf('"updated_at"')))).toBe(true);
    // No temp files left behind.
    expect(readdirSync(dirname(file))).toEqual(["prayers.json"]);
  });

  it("adds a text-only request; preview, publish (no git) and discard messages", async () => {
    const file = tempRepo();
    const store = await LocalStore.open(file);
    await store.apply(buildAddRequest(await store.current(), { text: { en: "Pray for **Bro Test's** exams.", te: "సహోదరుడు టెస్ట్ గారి పరీక్షల కొరకు ప్రార్థించండి." } }, ctx));
    const disk = validateRoot(JSON.parse(readFileSync(file, "utf8")));
    expect(resolveSlide(disk, "additional").requests.at(-1)!.text?.en).toBe("Pray for **Bro Test's** exams.");
    const d = await store.diff();
    expect(d.requests.additional!.added).toHaveLength(1);
    const res = await store.publish({});
    expect(res).toMatchObject({ mode: "local", published: false });
    expect(res.message).toMatch(/review and commit with git yourself/i);
    expect(res.commit_message).toMatch(/^Add prayer request: Pray for Bro Test's exams\. \(additional\)/);
    expect((await store.diff()).has_changes).toBe(false); // baseline reset
    expect(await store.discard()).toMatch(/git -C .* checkout -- data\/prayers.json/);
  });

  it("rejects invalid ops without touching the file", async () => {
    const file = tempRepo();
    const store = await LocalStore.open(file);
    const root = await store.current();
    const op = buildUpdateRequest(root, "madhavi", { label: null }, ctx);
    (op as any).patch = { name: null }; // corrupt: leaves neither name nor text
    await expect(store.apply(op)).rejects.toThrow(/exactly one of `text` or `name`/);
    expect(readFileSync(file, "utf8")).toBe(realText);
  });
});

// ---------------------------------------------------------------------------
// GitHub mode with a fake client
// ---------------------------------------------------------------------------

class FakeGitHub implements GitHubClient {
  branches = new Map<string, string>(); // branch -> commit sha
  commits = new Map<string, { text: string; blob: string }>(); // commit -> file state
  pulls: Array<{ title: string; body: string; head: string; base: string }> = [];
  puts: Array<{ branch: string; message: string; sha: string }> = [];
  /** Simulate someone else committing right before our next put (once). */
  raceOnNextPut?: (text: string) => string;
  private n = 0;

  constructor(text: string) {
    this.commitTo("main", text);
  }
  commitTo(branch: string, text: string) {
    const c = `c${++this.n}`;
    this.commits.set(c, { text, blob: `b${this.n}` });
    this.branches.set(branch, c);
    return c;
  }
  head(branch: string) {
    return this.commits.get(this.branches.get(branch)!)!;
  }
  async getBranchSha(branch: string) {
    const s = this.branches.get(branch);
    if (!s) throw Object.assign(new Error("Branch not found"), { status: 404 });
    return s;
  }
  async getFile(_path: string, ref: string) {
    const c = this.commits.get(ref) ?? this.commits.get(this.branches.get(ref)!);
    if (!c) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { content: c.text, sha: c.blob };
  }
  async createBranch(name: string, fromSha: string) {
    if (this.branches.has(name)) throw Object.assign(new Error("Reference already exists"), { status: 422 });
    this.branches.set(name, fromSha);
  }
  async putFile(a: { path: string; branch: string; content: string; message: string; sha: string }) {
    if (this.raceOnNextPut) {
      const f = this.raceOnNextPut;
      this.raceOnNextPut = undefined;
      this.commitTo(a.branch, f(this.head(a.branch).text));
    }
    if (this.head(a.branch).blob !== a.sha) throw Object.assign(new Error("is at b9 but expected " + a.sha), { status: 409 });
    this.puts.push({ branch: a.branch, message: a.message, sha: a.sha });
    const c = this.commitTo(a.branch, a.content);
    return { commitSha: c, commitUrl: `https://github.com/agimusa/prayer-tower/commit/${c}` };
  }
  async createPull(a: { title: string; body: string; head: string; base: string }) {
    this.pulls.push(a);
    return { url: `https://github.com/agimusa/prayer-tower/pull/${this.pulls.length}`, number: this.pulls.length };
  }
}

const open = (gh: FakeGitHub, publishMode: "pr" | "direct" = "pr") =>
  GitHubStore.open({ client: gh, repo: "agimusa/prayer-tower", branch: "main", file: "data/prayers.json", publishMode, now: ctx.now });

/** Simulate an edit made on the website: add a request on the remote main. */
const remoteAdd = (text: string, en: string) => {
  const root: Root = JSON.parse(text);
  return serialize(applyOp(root, buildAddRequest(root, { name: { en, te: "రిమోట్" }, source: "site", te_status: "needs_review" }, ctx)));
};

describe("GitHubStore", () => {
  it("PR flow: branch from base sha, commit, open PR, clear ops; main untouched", async () => {
    const gh = new FakeGitHub(realText);
    const store = await open(gh);
    await store.apply(buildAddRequest(await store.current(), { ...samuelLike, name: { en: "Samuel Newton", te: "శామ్యూల్ న్యూటన్" } }, ctx));
    expect(readFileSync(realFile, "utf8")).toBe(realText); // never touches disk
    expect(store.pendingOps()).toHaveLength(1);
    const res = await store.publish({});
    expect(res).toMatchObject({ mode: "pr", published: true, url: "https://github.com/agimusa/prayer-tower/pull/1", branch: "prayer-update-20261120-100000" });
    expect(gh.pulls[0]).toMatchObject({ head: "prayer-update-20261120-100000", base: "main", title: "Add prayer request: Samuel Newton (additional)" });
    expect(gh.puts[0]!.message).toBe("Add prayer request: Samuel Newton (additional)\n\nvia prayer-tower MCP");
    expect(gh.head("main").text).toBe(realText);
    const pushed = validateRoot(JSON.parse(gh.head("prayer-update-20261120-100000").text));
    expect(resolveSlide(pushed, "additional").requests.filter((r) => r.name?.en === "Samuel Newton")).toHaveLength(2);
    expect(store.pendingOps()).toHaveLength(0);
    expect((await store.diff()).has_changes).toBe(false);
    expect((await store.publish({})).published).toBe(false);
  });

  it("direct without confirm is rejected (also when direct is the env default); with confirm commits to main", async () => {
    const gh = new FakeGitHub(realText);
    const store = await open(gh, "direct");
    await store.apply(buildAddRequest(await store.current(), samuelLike, ctx));
    await expect(store.publish({})).rejects.toThrow(/confirm: true/);
    await expect(store.publish({ direct: true })).rejects.toThrow(/confirm: true/);
    await expect(store.publish({ direct: true, confirm: false })).rejects.toThrow(/confirm: true/);
    expect(gh.head("main").text).toBe(realText);
    const res = await store.publish({ direct: true, confirm: true, message: "Weekly update" });
    expect(res).toMatchObject({ mode: "direct", published: true });
    expect(res.url).toMatch(/\/commit\/c\d+$/);
    expect(gh.puts[0]!.message).toMatch(/^Weekly update\n\n- Add prayer request: Daniel Test \(additional\)\n\nvia prayer-tower MCP$/);
    expect(gh.pulls).toHaveLength(0);
    const main = validateRoot(JSON.parse(gh.head("main").text));
    expect(resolveSlide(main, "additional").requests.at(-1)!.name?.en).toBe("Daniel Test");
  });

  it("replays ops onto edits made on the site since the draft was loaded", async () => {
    const gh = new FakeGitHub(realText);
    const store = await open(gh);
    await store.apply(buildAddRequest(await store.current(), samuelLike, ctx));
    await store.apply(buildUpdateRequest(await store.current(), "madhavi", { label: { en: "Health", te: "ఆరోగ్యం" } }, ctx));
    gh.commitTo("main", remoteAdd(realText, "Added On Site"));
    await store.publish({ direct: true, confirm: true });
    const main = validateRoot(JSON.parse(gh.head("main").text));
    const names = resolveSlide(main, "additional").requests.map((r) => r.name?.en);
    expect(names).toContain("Added On Site");
    expect(names).toContain("Daniel Test");
    expect(findRequest(main, "madhavi").request.label?.en).toBe("Health");
  });

  it("on a 409 sha conflict refetches, replays and retries once", async () => {
    const gh = new FakeGitHub(realText);
    const store = await open(gh);
    await store.apply(buildAddRequest(await store.current(), samuelLike, ctx));
    gh.raceOnNextPut = (t) => remoteAdd(t, "Raced In");
    const res = await store.publish({ direct: true, confirm: true });
    expect(res.published).toBe(true);
    expect(gh.puts).toHaveLength(1);
    const names = resolveSlide(validateRoot(JSON.parse(gh.head("main").text)), "additional").requests.map((r) => r.name?.en);
    expect(names).toEqual(expect.arrayContaining(["Raced In", "Daniel Test"]));
  });

  it("gives up after a second conflict and keeps the ops", async () => {
    const gh = new FakeGitHub(realText);
    const store = await open(gh);
    await store.apply(buildAddRequest(await store.current(), samuelLike, ctx));
    const orig = gh.putFile.bind(gh);
    gh.putFile = async (a) => {
      gh.raceOnNextPut = (t) => remoteAdd(t, `Race ${Math.random()}`.replace(".", ""));
      return orig(a);
    };
    await expect(store.publish({ direct: true, confirm: true })).rejects.toMatchObject({ status: 409 });
    expect(store.pendingOps()).toHaveLength(1);
  });

  it("discard resets the draft to latest remote", async () => {
    const gh = new FakeGitHub(realText);
    const store = await open(gh);
    await store.apply(buildAddRequest(await store.current(), samuelLike, ctx));
    gh.commitTo("main", remoteAdd(realText, "Newer"));
    expect(await store.discard()).toMatch(/Discarded 1/);
    expect(store.pendingOps()).toHaveLength(0);
    expect(resolveSlide(await store.current(), "additional").requests.map((r) => r.name?.en)).toContain("Newer");
  });

  it("branch names are UTC timestamps", () => {
    expect(branchName(new Date("2026-01-02T03:04:05Z"))).toBe("prayer-update-20260102-030405");
  });
});
