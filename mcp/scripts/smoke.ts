// End-to-end smoke test of the built server over stdio (local mode).
//
//   npm run build && npm run smoke            # runs against a TEMP COPY of data/prayers.json
//   npm run smoke -- --real                   # runs against THIS checkout (modifies data/prayers.json!
//                                             #   revert with: git checkout -- data/prayers.json)
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const mcpDir = resolve(here, "..");
const repoRoot = resolve(mcpDir, "..");
const entry = join(mcpDir, "dist", "index.js");
const real = process.argv.includes("--real");

function fail(msg: string): never {
  console.error(`SMOKE FAILED: ${msg}`);
  process.exit(1);
}
const textOf = (r: any): string => (r.content ?? []).map((c: any) => c.text).join("\n");

async function main() {
  if (!existsSync(entry)) fail(`${entry} not found; run "npm run build" first`);

  let repoPath = repoRoot;
  let tmp: string | undefined;
  if (!real) {
    tmp = mkdtempSync(join(tmpdir(), "prayer-tower-smoke-"));
    mkdirSync(join(tmp, "data"));
    copyFileSync(join(repoRoot, "data", "prayers.json"), join(tmp, "data", "prayers.json"));
    repoPath = tmp;
  }
  const file = join(repoPath, "data", "prayers.json");
  const before = readFileSync(file, "utf8");
  console.log(`== smoke (${real ? "REAL checkout" : "temp copy"}): ${file}`);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "GITHUB_TOKEN") env[k] = v;
  env.PRAYER_TOWER_REPO_PATH = repoPath;

  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" });
  transport.stderr?.on("data", (d) => process.stderr.write(`  [server stderr] ${d}`));
  const client = new Client({ name: "prayer-tower-smoke", version: "0.0.0" });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    console.log(`\n== tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

    const slides = await client.callTool({ name: "list_slides", arguments: {} });
    console.log(`\n== list_slides\n${JSON.parse(textOf(slides)).map((s: any) => `  ${s.position}. ${s.id} (num ${s.num}, ${s.layout}) active=${s.active_requests}`).join("\n")}`);

    const add = await client.callTool({
      name: "add_prayer_request",
      arguments: {
        slide: "additional",
        name: { en: "MCP Smoke Test", te: "ఎంసీపీ స్మోక్ టెస్ట్" },
        note: { en: "(Twinkle Amjala's elder brother)", te: "(ట్వింకిల్ అమ్జాల గారి అన్నయ్య)" },
        items: [
          { en: "Healing from diabetes-related complications.", te: "మధుమేహ సంబంధిత సమస్యల నుండి స్వస్థత." },
          { en: "Complete recovery and strength.", te: "సంపూర్ణంగా కోలుకోవడం మరియు బలం." },
        ],
        te_status: "auto",
      },
    });
    if (add.isError) fail(`add_prayer_request: ${textOf(add)}`);
    console.log(`\n== add_prayer_request\n${textOf(add)}`);

    const get = await client.callTool({ name: "get_slide", arguments: { slide: "additional" } });
    const slide = JSON.parse(textOf(get));
    console.log(`\n== get_slide additional: ${slide.requests.map((r: any) => r.id).join(", ")}`);
    if (!slide.requests.some((r: any) => r.name?.en === "MCP Smoke Test")) fail("added request not returned by get_slide");

    console.log(`\n== preview_changes\n${textOf(await client.callTool({ name: "preview_changes", arguments: {} }))}`);
    const pub = await client.callTool({ name: "publish", arguments: {} });
    console.log(`\n== publish (local)\n${textOf(pub)}`);
    if (!/local mode/.test(textOf(pub))) fail("publish did not report local mode");

    const after = readFileSync(file, "utf8");
    if (after === before) fail("data/prayers.json did not change");
    const data = JSON.parse(after);
    const added = data.slides.find((s: any) => s.id === "additional").requests.find((r: any) => r.name?.en === "MCP Smoke Test");
    if (!added) fail("request not found in file on disk");
    console.log(`\n== file changed on disk: ${before.length} -> ${after.length} bytes; new id ${added.id}`);
    if (real) console.log(`   REAL checkout modified. Revert with: git -C "${repoRoot}" checkout -- data/prayers.json`);
    console.log("\nSMOKE OK");
  } finally {
    await client.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => fail(String(e?.stack ?? e)));
