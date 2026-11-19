// Read-side helpers: plain-text previews, summaries, search and diffs. Pure.
import type { Bi, PrayerRequest, Root, Slide } from "./schema.js";

const stripBold = (s: string) => s.replace(/\*\*/g, "");

/** Plain-text rendering of one row in one language, mirroring the site's layout rules. */
export function previewRow(r: PrayerRequest, lang: "en" | "te", layout: Slide["layout"] = "list"): string {
  const t = (b: Bi | undefined) => (b ? b[lang] : "");
  if (layout === "three-col") {
    const kids = (r.children ?? []).map(t).join(", ");
    const pts = (r.items ?? []).map((i) => `  • ${t(i)}`).join("\n");
    return `${t(r.name)} | ${kids}\n${pts}`;
  }
  if (r.text) return stripBold(t(r.text));
  let s = t(r.name);
  if (r.note) s += ` ${t(r.note)}`;
  if (r.label) s += ` - ${t(r.label)}`;
  if (r.detail) s += `${r.label ? ": " : " - "}${t(r.detail)}`;
  if (r.items?.length) s += "\n" + r.items.map((i) => `  • ${t(i)}`).join("\n");
  return s;
}

export function preview(r: PrayerRequest, layout: Slide["layout"] = "list"): string {
  return `EN: ${previewRow(r, "en", layout)}\nTE: ${previewRow(r, "te", layout)}`;
}

export function slideSummary(root: Root, s: Slide) {
  return {
    id: s.id,
    num: s.num,
    position: root.slides.indexOf(s) + 1,
    title: s.title,
    layout: s.layout,
    active_requests: s.requests.filter((r) => r.status === "active").length,
    total_requests: s.requests.length,
    ...(s.add_panel ? { add_panel: true } : {}),
  };
}

const FIELDS = ["name", "note", "label", "detail", "text", "items", "children", "answer"] as const;

function fieldTexts(r: PrayerRequest, f: (typeof FIELDS)[number]): string[] {
  const v = r[f];
  if (!v) return [];
  if (f === "answer") return r.answer?.text ? [r.answer.text.en, r.answer.text.te] : [];
  if (Array.isArray(v)) return v.flatMap((b) => [b.en, b.te]);
  const b = v as Bi;
  return [b.en, b.te];
}

export function searchRequests(root: Root, query: string, includeInactive = false) {
  const q = query.trim().toLowerCase();
  const results: Array<{ slide: string; id: string; status: string; te_status: string; matched: string[]; preview_en: string }> = [];
  if (!q) return results;
  for (const s of root.slides)
    for (const r of s.requests) {
      if (!includeInactive && r.status !== "active") continue;
      const matched = FIELDS.filter((f) => fieldTexts(r, f).some((x) => stripBold(x).toLowerCase().includes(q)));
      if (r.id.includes(q) && !matched.length) matched.push("id" as never);
      if (matched.length)
        results.push({ slide: s.id, id: r.id, status: r.status, te_status: r.te_status, matched, preview_en: previewRow(r, "en", s.layout) });
    }
  return results;
}

export function needsReview(root: Root) {
  const out: Array<{ slide: string; id: string; status: string; te_status: string; request: PrayerRequest }> = [];
  for (const s of root.slides)
    for (const r of s.requests)
      if (r.te_status === "auto" || r.te_status === "needs_review")
        out.push({ slide: s.id, id: r.id, status: r.status, te_status: r.te_status, request: r });
  return out;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export function serialize(root: Root, eol = "\n"): string {
  const s = JSON.stringify(root, null, 2) + "\n";
  return eol === "\n" ? s : s.replace(/\n/g, eol);
}

/** Count of added/removed lines between two texts (LCS-based). */
export function lineDiffCount(a: string, b: string): { added: number; removed: number } {
  const A = a.split("\n");
  const B = b.split("\n");
  // Trim common prefix/suffix to keep the LCS table small.
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length - 1;
  let endB = B.length - 1;
  while (endA >= start && endB >= start && A[endA] === B[endB]) {
    endA--;
    endB--;
  }
  const a2 = A.slice(start, endA + 1);
  const b2 = B.slice(start, endB + 1);
  const n = a2.length;
  const m = b2.length;
  if (n === 0 || m === 0) return { added: m, removed: n };
  if (n * m > 25_000_000) return { added: m, removed: n }; // give up gracefully on huge diffs
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++)
      cur[j] = a2[i - 1] === b2[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[m]!;
  return { added: m - lcs, removed: n - lcs };
}

type ReqLoc = { slide: string; index: number; request: PrayerRequest };
const index = (root: Root) => {
  const m = new Map<string, ReqLoc>();
  for (const s of root.slides) s.requests.forEach((r, i) => m.set(r.id, { slide: s.id, index: i, request: r }));
  return m;
};

export type RootDiff = {
  has_changes: boolean;
  slides_reordered?: { before: string[]; after: string[] };
  slides_added: string[];
  slides_removed: string[];
  slide_changes: Array<{ slide: string; fields: string[] }>;
  requests: Record<
    string,
    {
      added: Array<{ id: string; preview: string }>;
      removed: Array<{ id: string; preview: string }>;
      changed: Array<{ id: string; fields: string[]; preview: string }>;
      reordered?: boolean;
    }
  >;
  line_diff: { added: number; removed: number };
};

export function diffRoots(base: Root, draft: Root): RootDiff {
  const bi = index(base);
  const di = index(draft);
  const layoutOf = new Map(draft.slides.map((s) => [s.id, s.layout] as const));
  base.slides.forEach((s) => layoutOf.has(s.id) || layoutOf.set(s.id, s.layout));
  const requests: RootDiff["requests"] = {};
  const bucket = (slide: string) => (requests[slide] ??= { added: [], removed: [], changed: [] });

  for (const [id, d] of di) {
    const b = bi.get(id);
    const pv = previewRow(d.request, "en", layoutOf.get(d.slide));
    if (!b) {
      bucket(d.slide).added.push({ id, preview: pv });
      continue;
    }
    const fields = new Set<string>();
    const keys = new Set([...Object.keys(b.request), ...Object.keys(d.request)]);
    for (const k of keys)
      if (JSON.stringify((b.request as any)[k]) !== JSON.stringify((d.request as any)[k])) fields.add(k);
    if (b.slide !== d.slide) {
      fields.add(`moved from ${b.slide}`);
    }
    if (fields.size) bucket(d.slide).changed.push({ id, fields: [...fields], preview: pv });
  }
  for (const [id, b] of bi)
    if (!di.has(id)) bucket(b.slide).removed.push({ id, preview: previewRow(b.request, "en", layoutOf.get(b.slide)) });

  // Request order changes within a slide (ignoring adds/removes).
  for (const ds of draft.slides) {
    const bs = base.slides.find((s) => s.id === ds.id);
    if (!bs) continue;
    const common = new Set(bs.requests.map((r) => r.id).filter((id) => ds.requests.some((r) => r.id === id)));
    const bo = bs.requests.map((r) => r.id).filter((id) => common.has(id));
    const dorder = ds.requests.map((r) => r.id).filter((id) => common.has(id));
    if (bo.join() !== dorder.join()) bucket(ds.id).reordered = true;
  }

  const slide_changes: RootDiff["slide_changes"] = [];
  for (const ds of draft.slides) {
    const bs = base.slides.find((s) => s.id === ds.id);
    if (!bs) continue;
    const fields = (Object.keys({ ...bs, ...ds }) as (keyof Slide)[]).filter(
      (k) => k !== "requests" && JSON.stringify(bs[k]) !== JSON.stringify(ds[k]),
    );
    if (fields.length) slide_changes.push({ slide: ds.id, fields });
  }
  const bIds = base.slides.map((s) => s.id);
  const dIds = draft.slides.map((s) => s.id);
  const slides_added = dIds.filter((id) => !bIds.includes(id));
  const slides_removed = bIds.filter((id) => !dIds.includes(id));
  const commonB = bIds.filter((id) => dIds.includes(id));
  const commonD = dIds.filter((id) => bIds.includes(id));
  const slides_reordered = commonB.join() !== commonD.join() ? { before: bIds, after: dIds } : undefined;

  const baseNoTs = { ...base, updated_at: "" };
  const draftNoTs = { ...draft, updated_at: "" };
  const line_diff = lineDiffCount(serialize(base), serialize(draft));
  const has_changes = JSON.stringify(baseNoTs) !== JSON.stringify(draftNoTs);
  return {
    has_changes,
    ...(slides_reordered ? { slides_reordered } : {}),
    slides_added,
    slides_removed,
    slide_changes,
    requests,
    line_diff,
  };
}

/** Human-readable rendering of a RootDiff. */
export function formatDiff(d: RootDiff): string {
  if (!d.has_changes) return "No changes.";
  const out: string[] = [];
  if (d.slides_reordered) out.push(`Slide order: ${d.slides_reordered.before.join(", ")} -> ${d.slides_reordered.after.join(", ")}`);
  if (d.slides_added.length) out.push(`Slides added: ${d.slides_added.join(", ")}`);
  if (d.slides_removed.length) out.push(`Slides removed: ${d.slides_removed.join(", ")}`);
  for (const c of d.slide_changes) out.push(`Slide "${c.slide}" changed: ${c.fields.join(", ")}`);
  for (const [slide, r] of Object.entries(d.requests)) {
    if (!r.added.length && !r.removed.length && !r.changed.length && !r.reordered) continue;
    out.push(`\n[${slide}]`);
    for (const a of r.added) out.push(`  + ${a.id}: ${a.preview.replace(/\n/g, "\n      ")}`);
    for (const c of r.changed) out.push(`  ~ ${c.id} (${c.fields.join(", ")}): ${c.preview.split("\n")[0]}`);
    for (const x of r.removed) out.push(`  - ${x.id}: ${x.preview.split("\n")[0]}`);
    if (r.reordered) out.push(`  ↕ request order changed`);
  }
  out.push(`\nprayers.json: +${d.line_diff.added} / -${d.line_diff.removed} lines`);
  return out.join("\n").trim();
}
