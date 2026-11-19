import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyOp,
  buildAddRequest,
  buildMarkAnswered,
  buildMoveRequest,
  buildReorderRequests,
  buildReorderSlides,
  buildSetStatus,
  buildUpdateRequest,
  buildUpdateSlide,
  commitMessage,
  findRequest,
  OpError,
  replay,
  resolveSlide,
  slugify,
  type OpContext,
} from "../src/ops.js";
import { validateRoot, type Root } from "../src/schema.js";
import { diffRoots, formatDiff, preview, searchRequests } from "../src/view.js";

const here = dirname(fileURLToPath(import.meta.url));
const load = (): Root => JSON.parse(readFileSync(resolve(here, "../../data/prayers.json"), "utf8"));
let seq = 0;
const ctx: OpContext = { now: () => new Date("2026-11-20T10:00:00.000Z"), random: () => ((seq++ * 7) % 36) / 36 };

const samuel = {
  name: { en: "Samuel Newton", te: "శామ్యూల్ న్యూటన్" },
  note: { en: "(Twinkle Amjala's elder brother)", te: "(ట్వింకిల్ అమ్జాల గారి అన్నయ్య)" },
  items: [
    { en: "Healing from diabetes-related complications.", te: "మధుమేహ సంబంధిత సమస్యల నుండి స్వస్థత." },
    { en: "Complete recovery and strength.", te: "సంపూర్ణంగా కోలుకోవడం మరియు బలం." },
  ],
};

describe("helpers", () => {
  it("slugify", () => {
    expect(slugify("Bro Jala & Sis Jeru")).toBe("bro-jala-and-sis-jeru");
    expect(slugify("Pray for **Brother Kishore's** health and for the sale")).toBe("pray-for-brother-kishore-s-health");
    expect(slugify("శామ్యూల్")).toBe("request");
  });
  it("resolveSlide by id, num, title fragment; errors list slides", () => {
    const root = load();
    expect(resolveSlide(root, "additional").id).toBe("additional");
    expect(resolveSlide(root, 7).id).toBe("additional");
    expect(resolveSlide(root, "7").id).toBe("additional");
    expect(resolveSlide(root, "Founders").id).toBe("founders");
    expect(() => resolveSlide(root, "nope")).toThrow(/Slides: "children"/);
    expect(() => resolveSlide(root, "prayer")).toThrow(/ambiguous/);
  });
});

describe("add_request", () => {
  it("adds a Samuel-Newton-like request to additional by default, at the end", () => {
    const root = load();
    const op = buildAddRequest(root, { ...samuel, name: { en: "Samuel Newton Jr", te: "శామ్యూల్ న్యూటన్ జూ" } }, ctx);
    const next = applyOp(root, op);
    validateRoot(next);
    const s = resolveSlide(next, "additional");
    const r = s.requests.at(-1)!;
    expect(r.id).toMatch(/^samuel-newton-jr-[a-z0-9]{4}$/);
    expect(r).toMatchObject({ status: "active", source: "mcp", te_status: "auto", created_at: "2026-11-20T10:00:00.000Z" });
    expect(Object.keys(r)).toEqual(["id", "status", "visibility", "source", "created_at", "te_status", "name", "note", "items"]);
    expect(next.updated_at).toBe("2026-11-20T10:00:00.000Z");
    expect(op.summary).toBe("Add prayer request: Samuel Newton Jr (additional)");
    expect(preview(r)).toContain("EN: Samuel Newton Jr (Twinkle Amjala's elder brother)\n  • Healing");
    // input not mutated
    expect(resolveSlide(root, "additional").requests).toHaveLength(4);
  });

  it("adds text-only and label/detail rows at a position on a list slide", () => {
    const root = load();
    const op = buildAddRequest(root, { slide: "brothers", text: { en: "Pray for **Bro Ravi's** job.", te: "సహోదరుడు రవి గారి ఉద్యోగం కొరకు ప్రార్థించండి." }, position: 0 }, ctx);
    const next = applyOp(root, op);
    expect(resolveSlide(next, "brothers").requests[0]!.id).toMatch(/^pray-for-bro-ravi-s-job-/);
    const op2 = buildAddRequest(next, { slide: "sisters", name: { en: "Sis A", te: "సహోదరి A" }, label: { en: "Family", te: "కుటుంబం" }, detail: { en: "Job", te: "ఉద్యోగం" } }, ctx);
    expect(validateRoot(applyOp(next, op2))).toBeTruthy();
  });

  it("adds to the three-col children slide and enforces its shape", () => {
    const root = load();
    const ok = buildAddRequest(root, {
      slide: "children",
      name: { en: "Bro X & Sis Y", te: "X & Y" },
      children: [{ en: "Z", te: "జ" }],
      items: [{ en: "Health.", te: "ఆరోగ్యం." }],
    }, ctx);
    expect(resolveSlide(applyOp(root, ok), "children").requests).toHaveLength(11);
    expect(() => buildAddRequest(root, { slide: "children", name: { en: "P", te: "ప" }, items: [{ en: "a", te: "అ" }] }, ctx)).toThrow(/three-column.*children/);
    expect(() => buildAddRequest(root, { slide: "children", name: { en: "P", te: "ప" }, children: [{ en: "a", te: "అ" }], items: [{ en: "a", te: "అ" }], note: { en: "n", te: "న" } }, ctx)).toThrow(/not used on three-column/);
  });

  it("rejects bad combinations with helpful errors", () => {
    const root = load();
    expect(() => buildAddRequest(root, {}, ctx)).toThrow(/exactly one of `name`.*or `text`/);
    expect(() => buildAddRequest(root, { name: samuel.name, text: samuel.name }, ctx)).toThrow(OpError);
    expect(() => buildAddRequest(root, { text: samuel.name, items: samuel.items }, ctx)).toThrow(/cannot be combined with `text`/);
    expect(() => buildAddRequest(root, { name: samuel.name, children: samuel.items }, ctx)).toThrow(/only for three-column/);
    expect(() => buildAddRequest(root, { name: { en: "A", te: "" } }, ctx)).toThrow(/te must not be empty unless te_status is "needs_review"/);
    expect(() => buildAddRequest(root, { name: { en: "A", te: "" }, te_status: "needs_review" }, ctx)).not.toThrow();
    expect(() => buildAddRequest(root, { name: samuel.name, position: 99 }, ctx)).toThrow(/position must be/);
    expect(() => buildAddRequest(root, { slide: "zzz", name: samuel.name }, ctx)).toThrow(/no slide matches/);
  });

  it("generates unique ids even with colliding random suffixes", () => {
    const root = load();
    const fixed: OpContext = { ...ctx, random: (() => { let n = 0; return () => (n++ < 4 ? 0 : 0.5); })() };
    const a = applyOp(root, buildAddRequest(root, { name: { en: "Dup", te: "డ" } }, { ...ctx, random: () => 0 }));
    const op = buildAddRequest(a, { name: { en: "Dup", te: "డ" } }, fixed);
    expect(op.type === "add_request" && op.request.id).toBe("dup-iiii");
  });
});

describe("update/move/status", () => {
  it("updates fields and removes fields set to null", () => {
    const root = load();
    const op = buildUpdateRequest(root, "bro-jala-and-sis-jeru", { detail: null, label: { en: "Health", te: "ఆరోగ్యం" }, te_status: "auto" }, ctx);
    const r = findRequest(applyOp(root, op), "bro-jala-and-sis-jeru").request;
    expect(r.detail).toBeUndefined();
    expect(r.label).toEqual({ en: "Health", te: "ఆరోగ్యం" });
    expect(r.te_status).toBe("auto");
    expect(() => buildUpdateRequest(root, "bro-jala-and-sis-jeru", {}, ctx)).toThrow(/nothing to update/);
    expect(() => buildUpdateRequest(root, "nope", { label: null }, ctx)).toThrow(/no prayer request with id/);
    // switching name -> text requires removing the name
    expect(() => buildUpdateRequest(root, "madhavi", { text: { en: "x", te: "య" } }, ctx)).toThrow(/exactly one of `text` or `name`/);
    const sw = applyOp(root, buildUpdateRequest(root, "madhavi", { text: { en: "Pray for **Madhavi**", te: "మధావి" }, name: null, label: null }, ctx));
    expect(findRequest(sw, "madhavi").request.text?.en).toBe("Pray for **Madhavi**");
  });

  it("moves between slides and validates layout", () => {
    const root = load();
    const next = applyOp(root, buildMoveRequest(root, "madhavi", "sisters", 0, ctx));
    expect(resolveSlide(next, "sisters").requests[0]!.id).toBe("madhavi");
    expect(resolveSlide(next, "additional").requests.map((r) => r.id)).not.toContain("madhavi");
    expect(() => buildMoveRequest(root, "madhavi", "children", undefined, ctx)).toThrow(/three-col requests require/);
  });

  it("mark_answered, archive, restore", () => {
    const root = load();
    const ans = applyOp(root, buildMarkAnswered(root, "samuel-newton", { en: "Healed!", te: "స్వస్థత పొందారు!" }, ctx));
    const r = findRequest(ans, "samuel-newton").request;
    expect(r.status).toBe("answered");
    expect(r.answer).toEqual({ text: { en: "Healed!", te: "స్వస్థత పొందారు!" }, answered_at: "2026-11-20T10:00:00.000Z" });
    expect(findRequest(applyOp(root, buildMarkAnswered(root, "samuel-newton", undefined, ctx)), "samuel-newton").request.answer).toEqual({ answered_at: "2026-11-20T10:00:00.000Z" });
    const arch = applyOp(root, buildSetStatus(root, "madhavi", "archived", ctx));
    expect(findRequest(arch, "madhavi").request.status).toBe("archived");
    expect(() => buildSetStatus(arch, "madhavi", "archived", ctx)).toThrow(/already archived/);
    expect(findRequest(applyOp(arch, buildSetStatus(arch, "madhavi", "active", ctx)), "madhavi").request.status).toBe("active");
    expect(searchRequests(arch, "madhavi")).toHaveLength(0);
    expect(searchRequests(arch, "madhavi", true)).toHaveLength(1);
  });

  it("update_slide validates fields", () => {
    const root = load();
    const next = applyOp(root, buildUpdateSlide(root, "additional", { timer_seconds: 120, theme: "s-rose" }, ctx));
    expect(resolveSlide(next, "additional")).toMatchObject({ timer_seconds: 120, theme: "s-rose" });
    expect(() => buildUpdateSlide(root, "additional", { glow: "red" }, ctx)).toThrow(/glow/);
  });
});

describe("reorder", () => {
  it("reorder_slides requires a permutation", () => {
    const root = load();
    const ids = root.slides.map((s) => s.id);
    const rev = [...ids].reverse();
    expect(applyOp(root, buildReorderSlides(root, rev, ctx)).slides.map((s) => s.id)).toEqual(rev);
    expect(() => buildReorderSlides(root, ids.slice(1), ctx)).toThrow(/missing: children/);
    expect(() => buildReorderSlides(root, [...ids, "x"], ctx)).toThrow(/unknown: x/);
    expect(() => buildReorderSlides(root, [...ids.slice(1), ids[1]!], ctx)).toThrow(/permutation/);
  });
  it("reorder_requests requires a permutation; replay is lenient for remote additions", () => {
    const root = load();
    const ids = resolveSlide(root, "additional").requests.map((r) => r.id);
    const op = buildReorderRequests(root, "additional", [...ids].reverse(), ctx);
    expect(resolveSlide(applyOp(root, op), "additional").requests.map((r) => r.id)).toEqual([...ids].reverse());
    expect(() => buildReorderRequests(root, "additional", ids.slice(1), ctx)).toThrow(/missing/);
    // A newer base with an extra request: replay keeps it (at the end).
    const newer = applyOp(root, buildAddRequest(root, { name: { en: "Remote", te: "రిమోట్" } }, ctx));
    const out = replay(newer, [op]);
    expect(resolveSlide(out, "additional").requests.map((r) => r.id).slice(0, 4)).toEqual([...ids].reverse());
    expect(resolveSlide(out, "additional").requests).toHaveLength(5);
  });
});

describe("diff + commit message", () => {
  it("describes added/changed requests", () => {
    const root = load();
    const a = buildAddRequest(root, samuel, ctx);
    const r1 = applyOp(root, a);
    const b = buildUpdateRequest(r1, "madhavi", { label: { en: "Salvation & Health", te: "రక్షణ & ఆరోగ్యం" } }, ctx);
    const r2 = applyOp(r1, b);
    const d = diffRoots(root, r2);
    expect(d.has_changes).toBe(true);
    expect(d.requests.additional!.added).toHaveLength(1);
    expect(d.requests.additional!.changed[0]).toMatchObject({ id: "madhavi", fields: ["label"] });
    expect(d.line_diff.added).toBeGreaterThan(10);
    expect(formatDiff(d)).toContain("+ samuel-newton-");
    expect(commitMessage([a])).toBe("Add prayer request: Samuel Newton (additional)\n\nvia prayer-tower MCP");
    expect(commitMessage([a, b])).toMatch(/^Update prayer requests \(2 changes\)\n\n- Add prayer request: Samuel Newton \(additional\)\n- Update prayer request: Madhavi \(label\)\n\nvia prayer-tower MCP$/);
    expect(diffRoots(root, root).has_changes).toBe(false);
  });
});
