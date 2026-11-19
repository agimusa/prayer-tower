// Parity check: does index.html + assets/render.js + data/prayers.json produce the same
// prayer slides as the hand-written page on `main`?
//
//   npx tsx scripts/parity.ts            (from mcp/)  -> human-readable report, exit 1 on any diff
//
// The comparison helpers are also used by test/parity.test.ts.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../..");
export const paths = {
  index: resolve(REPO_ROOT, "index.html"),
  render: resolve(REPO_ROOT, "assets/render.js"),
  data: resolve(REPO_ROOT, "data/prayers.json"),
};

/** Git ref holding the hand-written page to compare against (override with PARITY_REF). */
export const ORIGINAL_REF = process.env.PARITY_REF || "main";

export const loadOriginalHtml = (ref = ORIGINAL_REF): string =>
  execSync(`git show ${ref}:index.html`, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
export const loadIndexHtml = (): string => readFileSync(paths.index, "utf8");
export const loadRenderJs = (): string => readFileSync(paths.render, "utf8");
export const loadData = (): any => JSON.parse(readFileSync(paths.data, "utf8"));

/** Collapse whitespace between tags; that whitespace has no effect on this page's layout (flex/grid containers). */
export const norm = (s: string): string => s.replace(/>\s+</g, "><").trim();

/** Parse the original page (scripts off). */
export function originalDocument(html = loadOriginalHtml()): Document {
  return new JSDOM(html).window.document;
}

/** Working-tree index.html with render.js evaluated in the window and the deck rendered from `data`. */
export function renderedDocument(data: any = loadData(), html = loadIndexHtml()): Document {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  dom.window.eval(loadRenderJs());
  (dom.window as any).PrayerRender.renderDeck(data, dom.window.document);
  return dom.window.document;
}

export interface Check {
  what: string;
  ok: boolean;
  original: string;
  rendered: string;
}
export interface SlideReport {
  key: string; // section id
  title: string;
  rows: { original: number; rendered: number };
  checks: Check[];
}
export interface ParityReport {
  slides: SlideReport[];
  page: Check[];
  ok: boolean;
}

const prayerSections = (doc: Document) => Array.from(doc.querySelectorAll<HTMLElement>("section.slide[id^='hdr-']"));
const html = (el: Element | null | undefined, outer = true) => (el ? norm(outer ? el.outerHTML : el.innerHTML) : "<missing>");
const text = (el: Element | null | undefined) => (el ? (el.textContent ?? "").trim() : "<missing>");
const rowEls = (sec: Element) => Array.from(sec.querySelectorAll(".rows > *"));

/** Everything in <body> except the prayer sections, comments and scripts. */
function chrome(doc: Document): string {
  const body = doc.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll("section.slide[id^='hdr-'], script").forEach((e) => e.remove());
  const walker = doc.createTreeWalker(body, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode!.removeChild(c));
  return norm(body.innerHTML);
}

export function compare(orig: Document, next: Document): ParityReport {
  const page: Check[] = [];
  const add = (list: Check[], what: string, original: string, rendered: string) =>
    list.push({ what, ok: original === rendered, original, rendered });

  const oSecs = prayerSections(orig);
  const nSecs = prayerSections(next);
  add(page, "prayer slide order", oSecs.map((s) => s.id).join(","), nSecs.map((s) => s.id).join(","));
  add(
    page,
    "all slide ids in order (incl. hero/outro)",
    Array.from(orig.querySelectorAll(".slide")).map((s) => s.id).join(","),
    Array.from(next.querySelectorAll(".slide")).map((s) => s.id).join(","),
  );
  add(page, "hero outerHTML", html(orig.getElementById("s-hero")), html(next.getElementById("s-hero")));
  add(page, "outro outerHTML", html(orig.getElementById("s-outro")), html(next.getElementById("s-outro")));
  const styles = (d: Document) => Array.from(d.querySelectorAll("style")).map((s) => s.textContent).join("\n/*--*/\n");
  add(page, "<style> content", styles(orig), styles(next));
  add(page, "<head> (minus scripts)", html(orig.head, false), html(next.head, false));
  add(page, "add-panel markup", html(orig.querySelector(".add-panel")), html(next.querySelector(".add-panel")));
  add(page, "page chrome (body minus prayer slides, scripts, comments)", chrome(orig), chrome(next));

  const slides: SlideReport[] = [];
  const n = Math.max(oSecs.length, nSecs.length);
  for (let i = 0; i < n; i++) {
    const o = oSecs[i];
    const r = nSecs[i];
    const key = o?.id ?? r?.id ?? `#${i}`;
    const checks: Check[] = [];
    const c = (what: string, a: string, b: string) => add(checks, what, a, b);
    const q = (sec: Element | undefined, sel: string) => sec?.querySelector(sel) ?? null;
    c("id", o?.id ?? "<missing>", r?.id ?? "<missing>");
    c("class", o?.className ?? "<missing>", r?.className ?? "<missing>");
    c("data-glow", o?.getAttribute("data-glow") ?? "<missing>", r?.getAttribute("data-glow") ?? "<missing>");
    c("index", text(q(o, ".slide-index")), text(q(r, ".slide-index")));
    c("title-en", html(q(o, ".slide-title-en"), false), html(q(r, ".slide-title-en"), false));
    c("title-te", html(q(o, ".slide-title-te"), false), html(q(r, ".slide-title-te"), false));
    c("timer", html(q(o, ".timer")), html(q(r, ".timer")));
    c("rows container id", q(o, ".rows")?.id ?? "<missing>", q(r, ".rows")?.id ?? "<missing>");
    const oRows = o ? rowEls(o) : [];
    const nRows = r ? rowEls(r) : [];
    c("row count", String(oRows.length), String(nRows.length));
    for (let j = 0; j < Math.max(oRows.length, nRows.length); j++) {
      const a = oRows[j];
      const b = nRows[j];
      c(`row ${j + 1} class`, a?.className ?? "<missing>", b?.className ?? "<missing>");
      c(`row ${j + 1} .en`, html(a?.querySelector(".en"), false), html(b?.querySelector(".en"), false));
      c(`row ${j + 1} .te`, html(a?.querySelector(".te"), false), html(b?.querySelector(".te"), false));
      c(`row ${j + 1} outerHTML`, html(a), html(b));
    }
    c("whole section", html(o), html(r));
    slides.push({ key, title: text(q(o ?? r, ".slide-title-en")), rows: { original: oRows.length, rendered: nRows.length }, checks });
  }
  const ok = page.every((x) => x.ok) && slides.every((s) => s.checks.every((x) => x.ok));
  return { slides, page, ok };
}

export function formatReport(rep: ParityReport): string {
  const out: string[] = [];
  const short = (s: string) => (s.length > 160 ? s.slice(0, 157) + "..." : s);
  out.push("Page");
  for (const c of rep.page) {
    out.push(`  ${c.ok ? "OK  " : "DIFF"} ${c.what}`);
    if (!c.ok) out.push(`       original: ${short(c.original)}`, `       rendered: ${short(c.rendered)}`);
  }
  for (const s of rep.slides) {
    const bad = s.checks.filter((c) => !c.ok);
    const rowChecks = s.checks.filter((c) => /^row \d+ outerHTML$/.test(c.what));
    out.push(
      `${s.key.padEnd(7)} ${bad.length ? "DIFF" : "OK  "} rows ${s.rows.original}/${s.rows.rendered}` +
        ` (${rowChecks.filter((c) => c.ok).length} identical)  ${s.title}`,
    );
    for (const c of bad) out.push(`    DIFF ${c.what}`, `       original: ${short(c.original)}`, `       rendered: ${short(c.rendered)}`);
  }
  const total = rep.slides.reduce((n, s) => n + s.checks.length, 0) + rep.page.length;
  const failed = rep.slides.reduce((n, s) => n + s.checks.filter((c) => !c.ok).length, 0) + rep.page.filter((c) => !c.ok).length;
  out.push(`${rep.ok ? "PARITY OK" : "PARITY FAILED"}: ${total - failed}/${total} checks identical`);
  return out.join("\n");
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const rep = compare(originalDocument(), renderedDocument());
  console.log(`Comparing ${ORIGINAL_REF}:index.html with index.html + assets/render.js + data/prayers.json\n`);
  console.log(formatReport(rep));
  process.exit(rep.ok ? 0 : 1);
}
