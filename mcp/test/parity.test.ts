// Parity between the hand-written page on `main` (override with PARITY_REF) and the
// data-driven page: index.html + assets/render.js + data/prayers.json.
import { afterEach, describe, expect, it } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import {
  ORIGINAL_REF,
  compare,
  formatReport,
  loadData,
  loadIndexHtml,
  loadRenderJs,
  originalDocument,
  renderedDocument,
} from "../scripts/parity.js";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe(`static parity with ${ORIGINAL_REF}:index.html`, () => {
  const report = compare(originalDocument(), renderedDocument());

  it("renders the same 7 prayer slides in the same order", () => {
    expect(report.slides.map((s) => s.key)).toEqual(["hdr-9", "hdr-6", "hdr-5", "hdr-2", "hdr-4", "hdr-7", "hdr-8"]);
  });

  for (const c of report.page) {
    it(`page: ${c.what}`, () => expect(c.rendered).toBe(c.original));
  }

  for (const s of report.slides) {
    it(`${s.key} (${s.title}): ${s.checks.length} checks`, () => {
      const bad = s.checks.filter((c) => !c.ok);
      // One readable failure message listing every differing part of the slide.
      expect(bad.map((c) => `${c.what}\n  original: ${c.original}\n  rendered: ${c.rendered}`)).toEqual([]);
    });
  }

  it("overall report is clean", () => {
    if (!report.ok) console.log(formatReport(report));
    expect(report.ok).toBe(true);
  });
});

describe("renderer behaviour", () => {
  const load = () => {
    const dom = new JSDOM("<main><section id='s-hero'></section><section id='s-outro'></section></main>", {
      runScripts: "outside-only",
    });
    dom.window.eval(loadRenderJs());
    return { dom, R: (dom.window as any).PrayerRender };
  };

  it("formats timers as M:SS", () => {
    const { R } = load();
    expect([300, 120, 75, 60, 9, 0].map(R.formatTimer)).toEqual(["5:00", "2:00", "1:15", "1:00", "0:09", "0:00"]);
  });

  it("escapes & < > \" and supports **bold**", () => {
    const { R } = load();
    expect(R.escapeHtml(`a & <b> "c" it's`)).toBe("a &amp; &lt;b&gt; &quot;c&quot; it's");
    expect(R.escapeWithBold("Pray for **<Kishore>**")).toBe("Pray for <strong>&lt;Kishore&gt;</strong>");
  });

  it("a slide with timer_seconds 120 renders 2:00", () => {
    const data = clone(loadData());
    data.slides[1].timer_seconds = 120;
    const doc = renderedDocument(data);
    const num = data.slides[1].num;
    expect(doc.getElementById(`td-${num}`)!.textContent).toBe("2:00");
    expect(doc.getElementById(`td-${data.slides[0].num}`)!.textContent).toBe("5:00");
  });

  it("does not render answered or archived requests", () => {
    const data = clone(loadData());
    const sisters = data.slides.find((s: any) => s.id === "sisters");
    const before = sisters.requests.filter((r: any) => r.status === "active").length;
    sisters.requests[0].status = "answered";
    sisters.requests[0].answer = { text: { en: "Answered", te: "జవాబు" }, answered_at: "2026-11-19T00:00:00.000Z" };
    sisters.requests[1].status = "archived";
    const doc = renderedDocument(data);
    const sec = doc.getElementById(`hdr-${sisters.num}`)!;
    expect(sec.querySelectorAll(".rows > .row").length).toBe(before - 2);
    expect(sec.textContent).not.toContain(sisters.requests[0].name.en);
    expect(sec.textContent).not.toContain(sisters.requests[1].name.en);
    expect(sec.textContent).not.toContain("Answered");
  });

  it("numbers slides NN / TT and inserts them between hero and outro", () => {
    const data = clone(loadData());
    data.slides = data.slides.slice(0, 3);
    const { dom, R } = load();
    const secs = R.renderDeck(data, dom.window.document);
    expect(secs.length).toBe(3);
    const ids = Array.from(dom.window.document.querySelectorAll("section")).map((s: any) => s.id);
    expect(ids).toEqual(["s-hero", "hdr-9", "hdr-6", "hdr-5", "s-outro"]);
    expect(Array.from(dom.window.document.querySelectorAll(".slide-index")).map((e: any) => e.textContent)).toEqual([
      "01 / 03",
      "02 / 03",
      "03 / 03",
    ]);
    // re-rendering replaces rather than duplicates
    R.renderDeck(data, dom.window.document);
    expect(dom.window.document.querySelectorAll("section[id^='hdr-']").length).toBe(3);
  });
});

// ------------------------------------------------------------------ full page with scripts running
interface Page {
  dom: JSDOM;
  win: any;
  doc: Document;
  jsdomErrors: unknown[];
  consoleErrors: string[];
}
const open: JSDOM[] = [];
afterEach(() => {
  while (open.length) open.pop()!.window.close();
});

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for page init");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function loadPage(opts: { data?: any; failFetch?: boolean } = {}): Promise<Page> {
  const data = opts.data ?? loadData();
  const jsdomErrors: unknown[] = [];
  const consoleErrors: string[] = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => jsdomErrors.push(e));
  vc.on("error", (...a: unknown[]) => consoleErrors.push(a.map(String).join(" ")));

  const src = loadIndexHtml();
  const tag = '<script src="assets/render.js"></script>';
  expect(src).toContain(tag);
  const html = src.replace(tag, () => `<script>${loadRenderJs()}</script>`);

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w: any) {
      w.fetch = async (url: string) => {
        if (opts.failFetch || !String(url).includes("data/prayers.json")) throw new w.TypeError("Failed to fetch");
        return { ok: true, status: 200, json: async () => clone(data) };
      };
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.AudioContext = class {
        currentTime = 0;
        destination = {};
        createOscillator() {
          return { connect() {}, start() {}, stop() {}, frequency: {} };
        }
        createGain() {
          return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } };
        }
      };
    },
  });
  open.push(dom);
  const doc = dom.window.document;
  await waitFor(() => doc.getElementById("rail")!.children.length > 0);
  return { dom, win: dom.window as any, doc, jsdomErrors, consoleErrors };
}

describe("full page (scripts running in jsdom)", () => {
  it("loads data, renders and wires up the deck without errors", async () => {
    const p = await loadPage();
    const ids = Array.from(p.doc.querySelectorAll(".slide")).map((s) => s.id);
    expect(ids).toEqual(["s-hero", "hdr-9", "hdr-6", "hdr-5", "hdr-2", "hdr-4", "hdr-7", "hdr-8", "s-outro"]);
    expect(p.doc.getElementById("rail")!.children.length).toBe(9);
    const hudTimers = p.doc.getElementById("hud-timers")!;
    expect(hudTimers.querySelectorAll(".timer").length).toBe(7);
    expect(p.doc.querySelectorAll("section .timer").length).toBe(0);
    expect(p.doc.getElementById("deck-error")).toBeNull();
    expect(p.doc.getElementById("tr-status")!.textContent).toMatch(/Type in English or Telugu/);
    expect(p.jsdomErrors).toEqual([]);
    expect(p.consoleErrors).toEqual([]);
  });

  it("toggleTimer / resetTimer work on a rendered slide", async () => {
    const p = await loadPage();
    p.win.toggleTimer(9);
    expect(p.doc.getElementById("btn-9")!.textContent).toBe("⏸");
    p.win.resetTimer(9);
    expect(p.doc.getElementById("td-9")!.textContent).toBe("5:00");
    expect(p.doc.getElementById("btn-9")!.textContent).toBe("▶");
    expect(p.jsdomErrors).toEqual([]);
  });

  it("uses per-slide timer_seconds for countdown and reset", async () => {
    const data = clone(loadData());
    data.slides.find((s: any) => s.num === 9).timer_seconds = 120;
    const p = await loadPage({ data });
    expect(p.doc.getElementById("td-9")!.textContent).toBe("2:00");
    expect(p.doc.getElementById("td-6")!.textContent).toBe("5:00");
    p.win.toggleTimer(9);
    await new Promise((r) => setTimeout(r, 1150));
    expect(p.doc.getElementById("td-9")!.textContent).toBe("01:59");
    p.win.resetTimer(9);
    expect(p.doc.getElementById("td-9")!.textContent).toBe("2:00");
    expect(p.jsdomErrors).toEqual([]);
  });

  it("shows an error between hero and outro when the data cannot be loaded, and still inits nav", async () => {
    const p = await loadPage({ failFetch: true });
    const err = p.doc.getElementById("deck-error")!;
    expect(err).not.toBeNull();
    expect(err.textContent).toMatch(/could not be loaded/);
    expect(err.previousElementSibling!.id).toBe("s-hero");
    expect(err.nextElementSibling!.id).toBe("s-outro");
    expect(Array.from(p.doc.querySelectorAll(".slide")).map((s) => s.id)).toEqual(["s-hero", "s-outro"]);
    expect(p.doc.getElementById("rail")!.children.length).toBe(2);
    expect(p.jsdomErrors).toEqual([]);
  });
});
