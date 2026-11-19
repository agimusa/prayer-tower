import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, TOOL_NAMES } from "../src/server.js";
import { LocalStore } from "../src/store.js";
import { validateRoot } from "../src/schema.js";
import { resolveSlide } from "../src/ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const realFile = resolve(here, "../../data/prayers.json");

let dir: string;
let file: string;
let client: Client;

const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "prayer-tower-mcp-"));
  mkdirSync(join(dir, "data"));
  file = join(dir, "data", "prayers.json");
  copyFileSync(realFile, file);
  const store = await LocalStore.open(file);
  const server = createServer(store, { log: () => {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
});
afterAll(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP server (in-memory, local mode)", () => {
  it("lists all tools with descriptions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const add = tools.find((t) => t.name === "add_prayer_request")!;
    expect(add.description).toMatch(/Telugu/);
    expect(add.description).toMatch(/publish/);
    expect(Object.keys((add.inputSchema as any).properties)).toEqual(
      expect.arrayContaining(["slide", "name", "note", "items", "text", "te_status", "position"]),
    );
  });

  it("list_slides and get_slide", async () => {
    const slides = JSON.parse(textOf(await client.callTool({ name: "list_slides", arguments: {} })));
    expect(slides.map((s: any) => s.id)).toEqual(["children", "brothers", "sisters", "ministries", "pastors", "additional", "founders"]);
    const g = await client.callTool({ name: "get_slide", arguments: { slide: 7 } });
    expect(JSON.parse(textOf(g)).id).toBe("additional");
  });

  it("add_prayer_request writes the file and returns a preview", async () => {
    const res = await client.callTool({
      name: "add_prayer_request",
      arguments: {
        name: { en: "MCP Test Person", te: "ఎంసీపీ టెస్ట్" },
        note: { en: "(Twinkle Amjala's elder brother)", te: "(ట్వింకిల్ అమ్జాల గారి అన్నయ్య)" },
        items: [{ en: "Healing from diabetes-related complications.", te: "మధుమేహ సంబంధిత సమస్యల నుండి స్వస్థత." }],
      },
    });
    expect(res.isError).toBeFalsy();
    const t = textOf(res);
    expect(t).toMatch(/Added "mcp-test-person-[a-z0-9]{4}" to slide "additional"/);
    expect(t).toContain("EN: MCP Test Person (Twinkle Amjala's elder brother)");
    const disk = validateRoot(JSON.parse(readFileSync(file, "utf8")));
    expect(resolveSlide(disk, "additional").requests.at(-1)!.name?.en).toBe("MCP Test Person");

    const search = await client.callTool({ name: "search_requests", arguments: { query: "ఎంసీపీ" } });
    expect(textOf(search)).toMatch(/1 match/);
    const review = await client.callTool({ name: "list_needs_review", arguments: {} });
    expect(textOf(review)).toContain("MCP Test Person");
    const pv = await client.callTool({ name: "preview_changes", arguments: {} });
    expect(textOf(pv)).toMatch(/\+ mcp-test-person-/);
  });

  it("returns helpful errors as isError results", async () => {
    const res = await client.callTool({ name: "add_prayer_request", arguments: { slide: "children", name: { en: "X", te: "య" } } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/three-column/);
    const r2 = await client.callTool({ name: "reorder_slides", arguments: { order: ["children"] } });
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toMatch(/permutation/);
  });

  it("publish in local mode does not run git", async () => {
    const res = await client.callTool({ name: "publish", arguments: {} });
    expect(textOf(res)).toMatch(/local mode: .* review and commit with git yourself/is);
    expect(textOf(res)).toMatch(/Add prayer request: MCP Test Person \(additional\)/);
  });

  it("resources: prayer://slides and prayer://slides/{id}", async () => {
    const r = await client.readResource({ uri: "prayer://slides" });
    expect(JSON.parse((r.contents[0] as any).text)).toHaveLength(7);
    const one = await client.readResource({ uri: "prayer://slides/founders" });
    expect(JSON.parse((one.contents[0] as any).text).id).toBe("founders");
    const { resources } = await client.listResources();
    expect(resources.map((x) => x.uri)).toEqual(expect.arrayContaining(["prayer://slides", "prayer://slides/additional"]));
  });

  it("prompts include real examples", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["telugu_review", "weekly_update"]);
    const p = await client.getPrompt({ name: "weekly_update", arguments: { message: "Please pray for Bro Ravi's job" } });
    const t = (p.messages[0]!.content as any).text as string;
    expect(t).toContain("Samuel Newton");
    expect(t).toContain("search_requests");
    expect(t).toContain("Please pray for Bro Ravi's job");
    const tr = await client.getPrompt({ name: "telugu_review", arguments: {} });
    expect((tr.messages[0]!.content as any).text).toContain("MCP Test Person");
  });
});
