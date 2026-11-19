import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateRoot, ValidationError, type Root } from "../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataPath = resolve(here, "../../data/prayers.json");
const load = (): any => JSON.parse(readFileSync(dataPath, "utf8"));

const req = (over: Record<string, unknown> = {}) => ({
  id: "bro-test",
  status: "active",
  visibility: "public",
  source: "manual",
  created_at: "2026-11-19T00:00:00.000Z",
  te_status: "human",
  name: { en: "Bro Test", te: "సహోదరుడు టెస్ట్" },
  ...over,
});
const listSlide = (requests: unknown[], over: Record<string, unknown> = {}) => ({
  id: "brothers",
  num: 6,
  title: { en: "Brothers", te: "సహోదరులు" },
  theme: "s-blue",
  glow: "#5f8cff",
  layout: "list",
  timer_seconds: 300,
  requests,
  ...over,
});
const root = (slides: unknown[]) => ({ version: 1, updated_at: "2026-11-19T00:00:00.000Z", slides });
const expectInvalid = (data: unknown, pattern: RegExp) => {
  expect(() => validateRoot(data)).toThrow(ValidationError);
  expect(() => validateRoot(data)).toThrow(pattern);
};

describe("data/prayers.json", () => {
  it("validates against the schema", () => {
    const data: Root = validateRoot(load());
    expect(data.version).toBe(1);
    expect(data.slides.map((s) => s.id)).toEqual(["children", "brothers", "sisters", "ministries", "pastors", "additional", "founders"]);
    expect(data.slides.map((s) => s.requests.length)).toEqual([10, 5, 22, 2, 7, 4, 8]);
  });

  it("stores Telugu as literal characters, 2-space indent, trailing newline", () => {
    const raw = readFileSync(dataPath, "utf8");
    expect(raw).not.toMatch(/\\u0c[0-9a-f]{2}/i);
    expect(raw).toContain("ప్రార్థన");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw.startsWith('{\n  "version": 1')).toBe(true);
  });

  it("round-trips through validateRoot unchanged", () => {
    const data = load();
    expect(validateRoot(data)).toEqual(data);
  });
});

describe("schema rejects invalid data", () => {
  it("accepts a minimal valid document", () => {
    expect(() => validateRoot(root([listSlide([req()])]))).not.toThrow();
  });

  it("rejects empty te when te_status is human", () => {
    expectInvalid(root([listSlide([req({ name: { en: "Bro Test", te: "" } })])]), /te must not be empty/);
  });

  it("allows empty te when te_status is needs_review", () => {
    expect(() => validateRoot(root([listSlide([req({ te_status: "needs_review", name: { en: "Bro Test", te: "" } })])]))).not.toThrow();
  });

  it("rejects missing te key", () => {
    expectInvalid(root([listSlide([req({ name: { en: "Bro Test" } })])]), /te/);
  });

  it("rejects both text and name", () => {
    expectInvalid(root([listSlide([req({ text: { en: "Pray", te: "ప్రార్థించండి" } })])]), /exactly one of `text` or `name`/);
  });

  it("rejects neither text nor name", () => {
    const r = req();
    delete (r as any).name;
    expectInvalid(root([listSlide([r])]), /exactly one of `text` or `name`/);
  });

  it("rejects duplicate request ids across slides", () => {
    const s2 = listSlide([req()], { id: "sisters", num: 5 });
    expectInvalid(root([listSlide([req()]), s2]), /duplicate request id "bro-test"/);
  });

  it("rejects duplicate slide ids and nums", () => {
    expectInvalid(root([listSlide([]), listSlide([], { num: 7 })]), /duplicate slide id "brothers"/);
    expectInvalid(root([listSlide([]), listSlide([], { id: "other" })]), /duplicate slide num 6/);
  });

  it("rejects three-col request missing children", () => {
    const slide = listSlide([req({ items: [{ en: "Health", te: "ఆరోగ్యం" }] })], {
      layout: "three-col",
      columns: {
        parents: { en: "Parents", te: "తల్లిదండ్రులు" },
        children: { en: "Children", te: "పిల్లలు" },
        prayer: { en: "Prayer Request", te: "ప్రార్థన విజ్ఞాపన" },
      },
    });
    expectInvalid(root([slide]), /three-col requests require non-empty `children`/);
  });

  it("rejects three-col slide without columns", () => {
    const slide = listSlide(
      [req({ children: [{ en: "Eric", te: "ఎరిక్" }], items: [{ en: "Health", te: "ఆరోగ్యం" }] })],
      { layout: "three-col" },
    );
    expectInvalid(root([slide]), /three-col slides require `columns`/);
  });

  it("rejects a bad status", () => {
    expectInvalid(root([listSlide([req({ status: "deleted" })])]), /status/);
  });

  it("rejects unknown fields and bad ids", () => {
    expectInvalid(root([listSlide([req({ colour: "red" })])]), /colour/);
    expectInvalid(root([listSlide([req({ id: "Bad Id" })])]), /slug/);
  });
});
