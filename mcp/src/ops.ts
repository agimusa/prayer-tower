// Pure operations on a prayers.json Root. No IO here.
//
// Every write is expressed as a serialisable Op whose ids/timestamps are fixed when the op
// is built. `applyOp(root, op)` is a pure function root -> root, so the ops log can be
// replayed onto a newer copy of the file fetched from GitHub at publish time.
import {
  validateRoot,
  ValidationError,
  type Bi,
  type PrayerRequest,
  type Root,
  type Slide,
  type TeStatus,
} from "./schema.js";

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpError";
  }
}

// ---------------------------------------------------------------------------
// Op types
// ---------------------------------------------------------------------------

export type RequestPatch = {
  name?: Bi | null;
  note?: Bi | null;
  label?: Bi | null;
  detail?: Bi | null;
  text?: Bi | null;
  items?: Bi[] | null;
  children?: Bi[] | null;
  plain?: boolean | null;
  te_status?: TeStatus;
};

export type SlidePatch = {
  title?: Bi;
  theme?: Slide["theme"];
  glow?: string;
  timer_seconds?: number;
};

type OpBase = { at: string; summary: string };

export type Op =
  | (OpBase & { type: "add_request"; slide: string; request: PrayerRequest; position?: number })
  | (OpBase & { type: "update_request"; id: string; patch: RequestPatch })
  | (OpBase & { type: "move_request"; id: string; to_slide: string; position?: number })
  | (OpBase & {
      type: "set_status";
      id: string;
      status: PrayerRequest["status"];
      answer?: PrayerRequest["answer"] | null;
    })
  | (OpBase & { type: "update_slide"; slide: string; patch: SlidePatch })
  | (OpBase & { type: "reorder_slides"; order: string[] })
  | (OpBase & { type: "reorder_requests"; slide: string; order: string[] });

/** Things that vary per call; injected so tests are deterministic. */
export type OpContext = {
  now?: () => Date;
  random?: () => number;
};

const nowIso = (ctx: OpContext) => (ctx.now ? ctx.now() : new Date()).toISOString();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clone = <T>(x: T): T => structuredClone(x);

export function slugify(s: string, maxWords = 6): string {
  const words = s
    .replace(/\*\*/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);
  return words.join("-") || "request";
}

export function allRequestIds(root: Root): Set<string> {
  const ids = new Set<string>();
  for (const s of root.slides) for (const r of s.requests) ids.add(r.id);
  return ids;
}

/** slug(name.en or first words of text.en) + "-" + 4 random base36 chars, unique within root. */
export function newRequestId(root: Root, base: string, ctx: OpContext = {}): string {
  const rnd = ctx.random ?? Math.random;
  const ids = allRequestIds(root);
  const slug = slugify(base);
  for (let attempt = 0; attempt < 1000; attempt++) {
    let suffix = "";
    for (let i = 0; i < 4; i++) suffix += Math.floor(rnd() * 36).toString(36);
    const id = `${slug}-${suffix}`;
    if (!ids.has(id)) return id;
  }
  throw new OpError("could not generate a unique id");
}

/** Resolve a slide reference: exact id, slide num, or a unique case-insensitive title fragment (EN or TE). */
export function resolveSlide(root: Root, ref: string | number): Slide {
  const str = String(ref).trim();
  const lower = str.toLowerCase();
  const byId = root.slides.find((s) => s.id === lower);
  if (byId) return byId;
  if (/^\d+$/.test(str)) {
    const byNum = root.slides.find((s) => s.num === Number(str));
    if (byNum) return byNum;
  }
  const matches = root.slides.filter(
    (s) => s.title.en.toLowerCase().includes(lower) || s.title.te.includes(str) || s.id.includes(lower),
  );
  if (matches.length === 1) return matches[0]!;
  const available = root.slides.map((s) => `"${s.id}" (num ${s.num}: ${s.title.en})`).join(", ");
  if (matches.length > 1)
    throw new OpError(
      `slide "${str}" is ambiguous; it matches ${matches.map((s) => `"${s.id}"`).join(", ")}. Use a slide id. Slides: ${available}`,
    );
  throw new OpError(`no slide matches "${str}". Slides: ${available}`);
}

export function findRequest(root: Root, id: string): { slide: Slide; index: number; request: PrayerRequest } {
  for (const slide of root.slides) {
    const index = slide.requests.findIndex((r) => r.id === id);
    if (index >= 0) return { slide, index, request: slide.requests[index]! };
  }
  throw new OpError(`no prayer request with id "${id}". Use search_requests or get_slide to find ids.`);
}

export function requestDisplayName(r: Pick<PrayerRequest, "name" | "text">): string {
  if (r.name) return r.name.en;
  if (r.text) {
    const t = r.text.en.replace(/\*\*/g, "");
    return t.length > 60 ? t.slice(0, 57) + "..." : t;
  }
  return "(unnamed)";
}

function insertAt<T>(arr: T[], item: T, position?: number): void {
  if (position === undefined || position >= arr.length) arr.push(item);
  else arr.splice(Math.max(0, position), 0, item);
}

function checkPosition(position: number | undefined, len: number, what: string) {
  if (position === undefined) return;
  if (!Number.isInteger(position) || position < 0 || position > len)
    throw new OpError(`${what} position must be an integer between 0 and ${len} (got ${position})`);
}

/** Validate a whole root, rethrowing as OpError with a readable message. */
export function validate(root: Root): Root {
  try {
    validateRoot(root);
    return root;
  } catch (e) {
    if (e instanceof ValidationError) throw new OpError(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// applyOp (pure; lenient where replay onto a newer base is reasonable)
// ---------------------------------------------------------------------------

const PATCH_KEYS = ["name", "note", "label", "detail", "text", "items", "children", "plain"] as const;

/** Rebuild a request with keys in canonical (schema) order so JSON diffs stay small. */
export function canonicalRequest(r: PrayerRequest): PrayerRequest {
  const order: (keyof PrayerRequest)[] = [
    "id", "status", "visibility", "source", "created_at", "te_status",
    "plain", "text", "name", "note", "label", "detail", "items", "children", "answer",
  ];
  const out: Record<string, unknown> = {};
  for (const k of order) if (r[k] !== undefined) out[k] = r[k];
  for (const k of Object.keys(r) as (keyof PrayerRequest)[]) if (!(k in out) && r[k] !== undefined) out[k] = r[k];
  return out as PrayerRequest;
}

export function applyOp(input: Root, op: Op): Root {
  const root = clone(input);
  switch (op.type) {
    case "add_request": {
      const slide = resolveSlide(root, op.slide);
      if (allRequestIds(root).has(op.request.id)) throw new OpError(`request id "${op.request.id}" already exists`);
      insertAt(slide.requests, clone(op.request), op.position);
      break;
    }
    case "update_request": {
      const { slide, index, request } = findRequest(root, op.id);
      const next: Record<string, unknown> = { ...request };
      for (const k of PATCH_KEYS) {
        if (!(k in op.patch)) continue;
        const v = op.patch[k];
        if (v === null) delete next[k];
        else if (v !== undefined) next[k] = clone(v);
      }
      if (op.patch.te_status) next.te_status = op.patch.te_status;
      slide.requests[index] = canonicalRequest(next as PrayerRequest);
      break;
    }
    case "move_request": {
      const { slide, index, request } = findRequest(root, op.id);
      const to = resolveSlide(root, op.to_slide);
      slide.requests.splice(index, 1);
      insertAt(to.requests, request, op.position);
      break;
    }
    case "set_status": {
      const { slide, index, request } = findRequest(root, op.id);
      const next: PrayerRequest = { ...request, status: op.status };
      if (op.answer === null) delete next.answer;
      else if (op.answer !== undefined) next.answer = clone(op.answer);
      slide.requests[index] = canonicalRequest(next);
      break;
    }
    case "update_slide": {
      const slide = resolveSlide(root, op.slide);
      if (op.patch.title !== undefined) slide.title = clone(op.patch.title);
      if (op.patch.theme !== undefined) slide.theme = op.patch.theme;
      if (op.patch.glow !== undefined) slide.glow = op.patch.glow;
      if (op.patch.timer_seconds !== undefined) slide.timer_seconds = op.patch.timer_seconds;
      break;
    }
    case "reorder_slides": {
      // Listed slides first in the given order; any slide not listed (e.g. added remotely) keeps its relative place at the end.
      const byId = new Map(root.slides.map((s) => [s.id, s]));
      const listed = op.order.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
      const rest = root.slides.filter((s) => !op.order.includes(s.id));
      root.slides = [...listed, ...rest];
      break;
    }
    case "reorder_requests": {
      const slide = resolveSlide(root, op.slide);
      const byId = new Map(slide.requests.map((r) => [r.id, r]));
      const listed = op.order.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
      const rest = slide.requests.filter((r) => !op.order.includes(r.id));
      slide.requests = [...listed, ...rest];
      break;
    }
    default: {
      const never: never = op;
      throw new OpError(`unknown op ${(never as Op).type}`);
    }
  }
  root.updated_at = op.at;
  return root;
}

/** Apply ops in order and validate the result. */
export function replay(root: Root, ops: Op[]): Root {
  return validate(ops.reduce(applyOp, root));
}

// ---------------------------------------------------------------------------
// Op builders: strict validation against the current root, then return the Op.
// ---------------------------------------------------------------------------

export type AddRequestInput = {
  slide?: string | number;
  name?: Bi;
  note?: Bi;
  label?: Bi;
  detail?: Bi;
  items?: Bi[];
  text?: Bi;
  children?: Bi[];
  plain?: boolean;
  te_status?: TeStatus;
  position?: number;
  source?: PrayerRequest["source"];
};

export function buildAddRequest(root: Root, input: AddRequestInput, ctx: OpContext = {}): Op {
  const slide = resolveSlide(root, input.slide ?? "additional");
  const hasText = input.text !== undefined;
  const hasName = input.name !== undefined;
  if (hasText === hasName)
    throw new OpError(
      "provide exactly one of `name` (a person/family, optionally with note/label/detail/items) or `text` (a free-form sentence; wrap names in **double asterisks** to bold them).",
    );
  if (hasText) {
    const extra = (["note", "label", "detail", "items", "children"] as const).filter((k) => input[k] !== undefined);
    if (extra.length)
      throw new OpError(`\`${extra.join("`, `")}\` cannot be combined with \`text\`; use \`name\` instead, or fold them into the sentence.`);
  }
  if (input.plain && !hasText) throw new OpError("`plain` rows must use `text`.");
  if (slide.layout === "three-col") {
    if (!hasName || !input.children?.length || !input.items?.length)
      throw new OpError(
        `slide "${slide.id}" is a three-column slide (${slide.columns?.parents.en ?? "Parents"} / ${slide.columns?.children.en ?? "Children"} / ${slide.columns?.prayer.en ?? "Prayer"}): it requires \`name\` (parents), non-empty \`children\` and non-empty \`items\` (prayer points).`,
      );
    const bad = (["note", "label", "detail", "plain"] as const).filter((k) => input[k] !== undefined);
    if (bad.length) throw new OpError(`\`${bad.join("`, `")}\` are not used on three-column slides.`);
  } else if (input.children !== undefined) {
    throw new OpError(`\`children\` is only for three-column slides; slide "${slide.id}" is a list slide. Put the points in \`items\` instead.`);
  }
  checkPosition(input.position, slide.requests.length, `slide "${slide.id}"`);

  const at = nowIso(ctx);
  const base = hasName ? input.name!.en : input.text!.en;
  const request = canonicalRequest({
    id: newRequestId(root, base, ctx),
    status: "active",
    visibility: "public",
    source: input.source ?? "mcp",
    created_at: at,
    te_status: input.te_status ?? "auto",
    plain: input.plain,
    text: input.text,
    name: input.name,
    note: input.note,
    label: input.label,
    detail: input.detail,
    items: input.items,
    children: input.children,
  } as PrayerRequest);
  const op: Op = {
    type: "add_request",
    at,
    summary: `Add prayer request: ${requestDisplayName(request)} (${slide.id})`,
    slide: slide.id,
    request,
    position: input.position,
  };
  validate(applyOp(root, op));
  return op;
}

export function buildUpdateRequest(root: Root, id: string, patch: RequestPatch, ctx: OpContext = {}): Op {
  const { request } = findRequest(root, id);
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (keys.length === 0) throw new OpError("nothing to update: pass at least one field (set a field to null to remove it).");
  const op: Op = {
    type: "update_request",
    at: nowIso(ctx),
    summary: `Update prayer request: ${requestDisplayName(request)} (${keys.join(", ")})`,
    id,
    patch,
  };
  validate(applyOp(root, op));
  return op;
}

export function buildMoveRequest(root: Root, id: string, toSlide: string | number, position: number | undefined, ctx: OpContext = {}): Op {
  const { request, slide: from } = findRequest(root, id);
  const to = resolveSlide(root, toSlide);
  const len = to.id === from.id ? to.requests.length - 1 : to.requests.length;
  checkPosition(position, len, `slide "${to.id}"`);
  const op: Op = {
    type: "move_request",
    at: nowIso(ctx),
    summary: `Move prayer request: ${requestDisplayName(request)} (${from.id} -> ${to.id})`,
    id,
    to_slide: to.id,
    position,
  };
  validate(applyOp(root, op));
  return op;
}

export function buildMarkAnswered(root: Root, id: string, testimony: Bi | undefined, ctx: OpContext = {}): Op {
  const { request } = findRequest(root, id);
  const at = nowIso(ctx);
  const op: Op = {
    type: "set_status",
    at,
    summary: `Mark prayer answered: ${requestDisplayName(request)}`,
    id,
    status: "answered",
    answer: testimony ? { text: testimony, answered_at: at } : { answered_at: at },
  };
  validate(applyOp(root, op));
  return op;
}

export function buildSetStatus(root: Root, id: string, status: "archived" | "active", ctx: OpContext = {}): Op {
  const { request } = findRequest(root, id);
  if (request.status === status) throw new OpError(`request "${id}" is already ${status}.`);
  const op: Op = {
    type: "set_status",
    at: nowIso(ctx),
    summary: `${status === "archived" ? "Archive" : "Restore"} prayer request: ${requestDisplayName(request)}`,
    id,
    status,
  };
  validate(applyOp(root, op));
  return op;
}

export function buildUpdateSlide(root: Root, slideRef: string | number, patch: SlidePatch, ctx: OpContext = {}): Op {
  const slide = resolveSlide(root, slideRef);
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (keys.length === 0) throw new OpError("nothing to update: pass title, theme, glow and/or timer_seconds.");
  const op: Op = {
    type: "update_slide",
    at: nowIso(ctx),
    summary: `Update slide: ${slide.id} (${keys.join(", ")})`,
    slide: slide.id,
    patch,
  };
  validate(applyOp(root, op));
  return op;
}

function checkPermutation(actual: string[], order: string[], what: string) {
  const dupes = order.filter((id, i) => order.indexOf(id) !== i);
  const missing = actual.filter((id) => !order.includes(id));
  const unknown = order.filter((id) => !actual.includes(id));
  if (dupes.length || missing.length || unknown.length) {
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
    if (unknown.length) parts.push(`unknown: ${unknown.join(", ")}`);
    if (dupes.length) parts.push(`duplicated: ${[...new Set(dupes)].join(", ")}`);
    throw new OpError(`order must be a permutation of all ${what} (${parts.join("; ")}). Current order: ${actual.join(", ")}`);
  }
}

export function buildReorderSlides(root: Root, order: string[], ctx: OpContext = {}): Op {
  checkPermutation(root.slides.map((s) => s.id), order, "slide ids");
  return { type: "reorder_slides", at: nowIso(ctx), summary: `Reorder slides: ${order.join(", ")}`, order };
}

export function buildReorderRequests(root: Root, slideRef: string | number, order: string[], ctx: OpContext = {}): Op {
  const slide = resolveSlide(root, slideRef);
  checkPermutation(slide.requests.map((r) => r.id), order, `request ids on slide "${slide.id}"`);
  return { type: "reorder_requests", at: nowIso(ctx), summary: `Reorder requests on slide: ${slide.id}`, slide: slide.id, order };
}

// ---------------------------------------------------------------------------
// Commit messages
// ---------------------------------------------------------------------------

export function commitMessage(ops: Op[], custom?: string): string {
  const trailer = "via prayer-tower MCP";
  const lines = ops.map((o) => `- ${o.summary}`);
  let title: string;
  if (custom && custom.trim()) title = custom.trim();
  else if (ops.length === 1) title = ops[0]!.summary;
  else {
    const adds = ops.filter((o) => o.type === "add_request");
    title =
      adds.length === ops.length
        ? `Add ${adds.length} prayer requests`
        : `Update prayer requests (${ops.length} changes)`;
  }
  const body = ops.length > 1 || custom ? `\n\n${lines.join("\n")}` : "";
  return `${title}${body}\n\n${trailer}`;
}
