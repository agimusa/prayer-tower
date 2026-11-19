// MCP server definition: tools, resources and prompts over a Store.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { THEMES, type PrayerRequest, type Root } from "./schema.js";
import {
  buildAddRequest,
  buildMarkAnswered,
  buildMoveRequest,
  buildReorderRequests,
  buildReorderSlides,
  buildSetStatus,
  buildUpdateRequest,
  buildUpdateSlide,
  findRequest,
  OpError,
  resolveSlide,
  type Op,
  type OpContext,
  type RequestPatch,
} from "./ops.js";
import { formatDiff, needsReview, preview, searchRequests, slideSummary } from "./view.js";
import type { Store } from "./store.js";

export const VERSION = "0.1.0";

export const TOOL_NAMES = [
  "list_slides",
  "get_slide",
  "search_requests",
  "list_needs_review",
  "add_prayer_request",
  "update_prayer_request",
  "move_request",
  "mark_answered",
  "archive_request",
  "restore_request",
  "update_slide",
  "reorder_slides",
  "reorder_requests",
  "preview_changes",
  "publish",
  "discard_changes",
] as const;

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------

const Bi = z
  .object({
    en: z.string().min(1).describe("English text"),
    te: z
      .string()
      .describe(
        'Telugu text. YOU must supply the Telugu translation (this server does not translate). Use "" only together with te_status "needs_review".',
      ),
  })
  .describe("Bilingual text {en, te}");

const SlideRef = z
  .union([z.string(), z.number()])
  .describe(
    'Slide reference: a slide id ("additional", "brothers", "sisters", "children", "founders", "pastors", "ministries"), a slide num, or a unique fragment of the title. Call list_slides to see them.',
  );

const TeStatus = z
  .enum(["human", "auto", "needs_review"])
  .describe(
    'Telugu quality: "auto" = machine/LLM translated (use this when YOU translated it), "human" = written or confirmed by a Telugu speaker (only when the user supplied the Telugu or explicitly confirmed it), "needs_review" = Telugu missing or doubtful (te may be "").',
  );

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const json = (v: unknown, note?: string): ToolResult => text((note ? note + "\n\n" : "") + JSON.stringify(v, null, 2));
const fail = (e: unknown): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
});

/** Strip metadata from a request for compact display. */
function content(r: PrayerRequest) {
  const { id, status, te_status, ...rest } = r;
  const { visibility, source, created_at, ...fields } = rest;
  void visibility, source, created_at;
  return { id, status, te_status, ...fields };
}

export type ServerOptions = { ctx?: OpContext; log?: (msg: string) => void };

export function createServer(store: Store, opts: ServerOptions = {}): McpServer {
  const ctx = opts.ctx ?? {};
  const log = opts.log ?? ((m: string) => process.stderr.write(`[prayer-tower] ${m}\n`));
  const server = new McpServer(
    { name: "prayer-tower", version: VERSION },
    {
      instructions:
        "Manages the AGIM Prayer Tower slideshow (bilingual English/Telugu prayer requests, data/prayers.json in agimusa/prayer-tower, served by GitHub Pages). " +
        "Workflow: search_requests first to avoid duplicates -> add_prayer_request / update_prayer_request (you supply the Telugu; te_status 'auto' for your translations) -> preview_changes -> show the user -> publish. " +
        "Default slide for new requests is 'additional'. " +
        store.describe(),
    },
  );

  // Serialise writes so concurrent tool calls cannot interleave read-modify-write.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  };
  const write = (build: (root: Root) => Op) =>
    exclusive(async () => {
      const op = build(await store.current());
      const next = await store.apply(op);
      log(op.summary);
      return { op, next };
    });
  const pendingNote = () =>
    store.mode === "github"
      ? `Saved to the draft (${store.pendingOps().length} unpublished change(s)). Call preview_changes, confirm with the user, then publish.`
      : `Written to ${store.describe().replace(/^local mode: editing /, "").replace(/ directly.*$/, "")}. Call preview_changes / publish when done.`;

  // ------------------------------------------------------------------ read
  server.registerTool(
    "list_slides",
    {
      title: "List slides",
      description: "List all prayer slides in display order with id, num, position, bilingual titles, layout and active request count.",
      annotations: READ,
    },
    async () => {
      try {
        const root = await store.current();
        return json(root.slides.map((s) => slideSummary(root, s)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_slide",
    {
      title: "Get slide",
      description:
        "Get one slide with all its requests (including ids, status and te_status). Use the ids with update_prayer_request, move_request, mark_answered, etc.",
      inputSchema: { slide: SlideRef },
      annotations: READ,
    },
    async ({ slide }) => {
      try {
        const root = await store.current();
        const s = resolveSlide(root, slide);
        return json({ ...slideSummary(root, s), theme: s.theme, glow: s.glow, timer_seconds: s.timer_seconds, columns: s.columns, requests: s.requests.map(content) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "search_requests",
    {
      title: "Search requests",
      description:
        "Case-insensitive substring search over names, notes, labels, details, text, bullet items, children and testimonies, in both English and Telugu. Always search before adding to avoid duplicates (e.g. search the person's name).",
      inputSchema: {
        query: z.string().min(1).describe("Text to look for, e.g. a name like \"Newton\" or a word like \"healing\""),
        include_inactive: z.boolean().optional().describe("Also search answered/archived requests (default false)"),
      },
      annotations: READ,
    },
    async ({ query, include_inactive }) => {
      try {
        const res = searchRequests(await store.current(), query, include_inactive ?? false);
        return json(res, `${res.length} match(es) for "${query}".`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_needs_review",
    {
      title: "List Telugu needing review",
      description: 'List requests whose Telugu is machine-translated (te_status "auto") or missing/doubtful ("needs_review").',
      annotations: READ,
    },
    async () => {
      try {
        const res = needsReview(await store.current()).map((x) => ({ slide: x.slide, ...content(x.request) }));
        return json(res, `${res.length} request(s) need Telugu review.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ----------------------------------------------------------------- write
  server.registerTool(
    "add_prayer_request",
    {
      title: "Add prayer request",
      description: [
        "Add a bilingual prayer request to a slide (default slide \"additional\" = Additional Prayer Requests).",
        "You MUST supply both English and Telugu for every field: translate to Telugu yourself, matching the style of existing entries (use get_slide to see examples; names are transliterated, e.g. \"Samuel Newton\" -> \"శామ్యూల్ న్యూటన్\"). Set te_status \"auto\" for your own translations (the default).",
        "Shapes: use `name` (bold) + optional `note` (shown after the name, e.g. \"(Twinkle Amjala's elder brother)\"), `label` (e.g. \"Health\"), `detail`, and `items` (bullet points) — OR a single free-form `text` sentence (wrap names in **double asterisks** to bold them). Never both name and text.",
        "Example: \"Add prayer request for Samuel Newton, Twinkle Amjala's elder brother: healing from diabetes complications, infection in right ankle\" => name {en:\"Samuel Newton\"}, note {en:\"(Twinkle Amjala's elder brother)\"}, items [{en:\"Healing from diabetes-related complications.\"}, {en:\"Healing from infection in his right ankle and leg.\"}] (each with te).",
        "Three-column slide \"children\": name = parents, children = list of child names, items = prayer points (all required).",
        "Search first (search_requests) to avoid duplicates. Changes are not live until you call publish (after preview_changes and the user's OK).",
      ].join("\n"),
      inputSchema: {
        slide: SlideRef.optional().describe('Target slide (default "additional")'),
        name: Bi.optional().describe("Person/family name, rendered bold"),
        note: Bi.optional().describe('Text right after the name, usually parenthesised: "(Twinkle Amjala\'s elder brother)"'),
        label: Bi.optional().describe('Short category after " - ", e.g. "Family", "Health", "Salvation", "Family & Ministry"'),
        detail: Bi.optional().describe('Specific need after the label (": ") or name (" - "), e.g. "Fruit of Womb", "Job"'),
        items: z.array(Bi).optional().describe("Bullet points (each a short sentence). On three-col slides these are the prayer points."),
        text: Bi.optional().describe("Free-form sentence instead of name; **bold** supported. Cannot be combined with name/note/label/detail/items."),
        children: z.array(Bi).optional().describe('Three-column slides only ("children"): the children\'s names'),
        plain: z.boolean().optional().describe("Render as a plain unstyled row (text only; rarely needed)"),
        te_status: TeStatus.optional().describe('Default "auto". See enum description.'),
        position: z.number().int().min(0).optional().describe("0-based index within the slide's requests; default = end"),
      },
      annotations: WRITE,
    },
    async (args) => {
      try {
        const { op, next } = await write((root) => buildAddRequest(root, args as never, ctx));
        if (op.type !== "add_request") throw new Error("unexpected op");
        const s = resolveSlide(next, op.slide);
        return json(
          { slide: s.id, request: op.request, preview: preview(op.request, s.layout) },
          `Added "${op.request.id}" to slide "${s.id}". ${pendingNote()}`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_prayer_request",
    {
      title: "Update prayer request",
      description:
        "Change fields of an existing request by id. Omitted fields are unchanged; set a field to null to remove it. Supply both en and te for each changed field. " +
        'If you change Telugu yourself set te_status "auto"; set "human" only after the user (a Telugu reader) confirms it.',
      inputSchema: {
        id: z.string().describe("Request id (from get_slide / search_requests)"),
        name: Bi.nullable().optional(),
        note: Bi.nullable().optional(),
        label: Bi.nullable().optional(),
        detail: Bi.nullable().optional(),
        items: z.array(Bi).nullable().optional().describe("Replaces the whole bullet list"),
        text: Bi.nullable().optional(),
        children: z.array(Bi).nullable().optional().describe("Three-col only; replaces the whole list"),
        plain: z.boolean().nullable().optional(),
        te_status: TeStatus.optional(),
      },
      annotations: WRITE,
    },
    async ({ id, ...patch }) => {
      try {
        const { next } = await write((root) => buildUpdateRequest(root, id, patch as RequestPatch, ctx));
        const { slide, request } = findRequest(next, id);
        return json({ slide: slide.id, request: content(request), preview: preview(request, slide.layout) }, `Updated "${id}". ${pendingNote()}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "move_request",
    {
      title: "Move request",
      description: "Move a request to another slide (or another position on the same slide).",
      inputSchema: {
        id: z.string().describe("Request id"),
        to_slide: SlideRef,
        position: z.number().int().min(0).optional().describe("0-based index in the target slide; default = end"),
      },
      annotations: WRITE,
    },
    async ({ id, to_slide, position }) => {
      try {
        const { op } = await write((root) => buildMoveRequest(root, id, to_slide, position, ctx));
        return text(`${op.summary}. ${pendingNote()}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "mark_answered",
    {
      title: "Mark answered",
      description:
        "Mark a prayer as answered (it disappears from the site but is kept in the data). Optionally record a bilingual testimony; you supply the Telugu.",
      inputSchema: { id: z.string().describe("Request id"), testimony: Bi.optional().describe("What God did, e.g. \"Healed and discharged from hospital\"") },
      annotations: WRITE,
    },
    async ({ id, testimony }) => {
      try {
        const { op } = await write((root) => buildMarkAnswered(root, id, testimony, ctx));
        return text(`${op.summary}. ${pendingNote()}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "archive_request",
    {
      title: "Archive request",
      description: "Hide a request from the site without marking it answered (e.g. no longer relevant). Reversible with restore_request.",
      inputSchema: { id: z.string().describe("Request id") },
      annotations: WRITE,
    },
    async ({ id }) => {
      try {
        const { op } = await write((root) => buildSetStatus(root, id, "archived", ctx));
        return text(`${op.summary}. ${pendingNote()}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "restore_request",
    {
      title: "Restore request",
      description: "Make an archived or answered request active (visible) again.",
      inputSchema: { id: z.string().describe("Request id") },
      annotations: WRITE,
    },
    async ({ id }) => {
      try {
        const { op } = await write((root) => buildSetStatus(root, id, "active", ctx));
        return text(`${op.summary}. ${pendingNote()}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_slide",
    {
      title: "Update slide",
      description: "Change a slide's bilingual title, colour theme, glow colour or timer length.",
      inputSchema: {
        slide: SlideRef,
        title: Bi.optional(),
        theme: z.enum(THEMES).optional().describe("Colour theme CSS class"),
        glow: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional().describe("Glow hex colour, e.g. #818cf8"),
        timer_seconds: z.number().int().positive().optional().describe("Prayer timer length in seconds (default 300)"),
      },
      annotations: WRITE,
    },
    async ({ slide, ...patch }) => {
      try {
        const { op } = await write((root) => buildUpdateSlide(root, slide, patch, ctx));
        return text(`${op.summary}. ${pendingNote()}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "reorder_slides",
    {
      title: "Reorder slides",
      description: "Set the display order of slides. `order` must list every slide id exactly once (see list_slides).",
      inputSchema: { order: z.array(z.string()).min(1).describe("All slide ids in the new order") },
      annotations: WRITE,
    },
    async ({ order }) => {
      try {
        const { op } = await write((root) => buildReorderSlides(root, order, ctx));
        return text(`${op.summary}. ${pendingNote()}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "reorder_requests",
    {
      title: "Reorder requests",
      description: "Set the order of requests on one slide. `order` must list every request id on that slide exactly once (see get_slide).",
      inputSchema: { slide: SlideRef, order: z.array(z.string()).min(1).describe("All request ids of the slide in the new order") },
      annotations: WRITE,
    },
    async ({ slide, order }) => {
      try {
        const { op } = await write((root) => buildReorderRequests(root, slide, order, ctx));
        return text(`${op.summary}. ${pendingNote()}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --------------------------------------------------------------- publish
  server.registerTool(
    "preview_changes",
    {
      title: "Preview changes",
      description:
        "Show what will be published: added/changed/removed requests per slide, slide changes, and a line-diff count of prayers.json. Show this to the user before publish.",
      annotations: READ,
    },
    async () => {
      try {
        const d = await store.diff();
        const ops = store.pendingOps().map((o) => o.summary);
        return text(`${store.describe()}\n\n${formatDiff(d)}${ops.length ? `\n\nPending operations:\n${ops.map((o) => `- ${o}`).join("\n")}` : ""}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "publish",
    {
      title: "Publish",
      description:
        "Publish pending changes to GitHub (agimusa/prayer-tower). Default: opens a pull request (safe; site updates when it is merged) and returns its URL. " +
        "direct: true commits straight to main so the live site updates within minutes — this REQUIRES confirm: true, which you may only set after showing preview_changes to the user and getting their explicit OK. " +
        "Latest changes made on the website are fetched and preserved. In local mode nothing is pushed: it reports the diff and tells the user to commit with git.",
      inputSchema: {
        message: z.string().optional().describe("Commit/PR title; default is generated from the changes"),
        direct: z.boolean().optional().describe("Commit directly to the base branch (live immediately) instead of opening a PR"),
        confirm: z.boolean().optional().describe("Must be true for direct publishing; set only after the user explicitly approved"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const res = await exclusive(() => store.publish(args));
        log(`publish: ${res.mode} ${res.published ? res.url ?? "" : "(not published)"}`);
        const lines = [res.message];
        if (res.url) lines.push(`URL: ${res.url}`);
        if (res.branch) lines.push(`Branch: ${res.branch}`);
        if (res.commit_message) lines.push(`\nCommit message:\n${res.commit_message}`);
        if (res.diff) lines.push(`\nChanges:\n${res.diff}`);
        return text(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "discard_changes",
    {
      title: "Discard changes",
      description: "Drop all unpublished changes (GitHub mode) and reload the latest data. In local mode edits are already on disk; this explains how to revert with git.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return text(await exclusive(() => store.discard()));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ------------------------------------------------------------- resources
  server.registerResource(
    "slides",
    "prayer://slides",
    { title: "Prayer slides", description: "All slides (summary) in display order", mimeType: "application/json" },
    async (uri) => {
      const root = await store.current();
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(root.slides.map((s) => slideSummary(root, s)), null, 2) }] };
    },
  );

  server.registerResource(
    "slide",
    new ResourceTemplate("prayer://slides/{id}", {
      list: async () => {
        const root = await store.current();
        return {
          resources: root.slides.map((s) => ({ uri: `prayer://slides/${s.id}`, name: s.title.en, mimeType: "application/json" })),
        };
      },
    }),
    { title: "Prayer slide", description: "One slide with all its requests", mimeType: "application/json" },
    async (uri, { id }) => {
      const root = await store.current();
      const s = resolveSlide(root, String(id));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(s, null, 2) }] };
    },
  );

  // --------------------------------------------------------------- prompts
  server.registerPrompt(
    "weekly_update",
    {
      title: "Weekly prayer update",
      description: "Turn a pasted WhatsApp prayer message into structured bilingual prayer requests.",
      argsSchema: { message: z.string().describe("The pasted WhatsApp message") },
    },
    async ({ message }) => {
      const root = await store.current();
      const examples = pickExamples(root);
      const slides = root.slides.map((s) => `- ${s.id} (num ${s.num}, ${s.layout}): ${s.title.en}`).join("\n");
      const body = `You are updating the AGIM Prayer Tower slideshow from a WhatsApp message.

Slides:
${slides}

Steps:
1. Parse the message below into individual prayer requests (one per person/family/topic).
2. Choose a slide for each: church members -> "brothers" or "sisters" (by the person's gender / "Bro"/"Sis"); prayers for children with parents -> "children" (three-column: name = parents, children = child names, items = prayer points); the founders' family -> "founders"; pastors -> "pastors"; everything else -> "additional".
3. For each request call search_requests with the person's name first. If an entry exists, use update_prayer_request instead of adding a duplicate.
4. Translate every field into Telugu yourself, in the style of the existing entries (transliterate names, use సహోదరుడు/సహోదరి for Bro/Sis, short devotional phrasing). Set te_status "auto".
5. Call add_prayer_request (or update_prayer_request) for each.
6. Call preview_changes, show the result to the user, and ASK before calling publish. Only use publish with direct: true + confirm: true if the user explicitly wants it live immediately; otherwise publish opens a pull request.

Real examples of existing entries (fields as stored):
${examples.map((e) => "```json\n" + JSON.stringify(e, null, 2) + "\n```").join("\n")}

WhatsApp message:
"""
${message}
"""`;
      return { messages: [{ role: "user", content: { type: "text", text: body } }] };
    },
  );

  server.registerPrompt(
    "telugu_review",
    {
      title: "Telugu review",
      description: "Review machine-translated Telugu and propose corrections.",
    },
    async () => {
      const items = needsReview(await store.current()).map((x) => ({ slide: x.slide, ...content(x.request) }));
      const body = items.length
        ? `These prayer requests have Telugu that is machine-translated ("auto") or missing ("needs_review"):

\`\`\`json
${JSON.stringify(items, null, 2)}
\`\`\`

For each one, show the English and the current Telugu side by side and propose corrected, natural Telugu in the style of the existing human-written entries. Then ask the user (a Telugu reader) to confirm or edit each proposal. Only after they confirm a request, call update_prayer_request with the corrected fields and te_status "human". Leave unconfirmed ones as they are. Finally call preview_changes and ask before publishing.`
        : "There are no requests with te_status \"auto\" or \"needs_review\". Tell the user the Telugu is fully reviewed.";
      return { messages: [{ role: "user", content: { type: "text", text: body } }] };
    },
  );

  return server;
}

function pickExamples(root: Root) {
  const list = root.slides.filter((s) => s.layout === "list").flatMap((s) => s.requests.filter((r) => r.status === "active" && r.te_status === "human"));
  const strip = (r: PrayerRequest) => {
    const { id, status, visibility, source, created_at, te_status, ...rest } = r;
    void id, status, visibility, source, created_at, te_status;
    return rest;
  };
  const picks = [
    list.find((r) => r.name && r.note && r.items?.length),
    list.find((r) => r.name && r.label && r.detail),
    list.find((r) => r.text),
  ].filter((r): r is PrayerRequest => !!r);
  return picks.map(strip);
}

export { OpError };
