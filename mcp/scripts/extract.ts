// One-off migration: index.html (default: `git show main:index.html`) -> data/prayers.json
//
// Usage: npm run extract -- [--html <file>] [--csv <file>] [--out <file>]
//
// After building the JSON it re-renders every row with the SPEC rendering rules and
// compares against the original row HTML (whitespace between tags normalised).
// Any mismatch is printed and the script exits non-zero without writing.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { validateRoot, type Bi, type Columns, type PrayerRequest, type Root, type Slide } from "../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const CREATED_AT = "2026-11-19T00:00:00.000Z";

const SLIDE_IDS: Record<number, string> = {
  9: "children",
  6: "brothers",
  5: "sisters",
  2: "ministries",
  4: "pastors",
  7: "additional",
  8: "founders",
};

// ---------------------------------------------------------------- args
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const htmlPath = arg("html");
const csvPath = arg("csv");
const outPath = resolve(arg("out") ?? resolve(repoRoot, "data/prayers.json"));

const html = htmlPath
  ? readFileSync(htmlPath, "utf8")
  : execFileSync("git", ["-C", repoRoot, "show", "main:index.html"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const doc = new JSDOM(html).window.document;

// ---------------------------------------------------------------- helpers
const ids = new Set<string>();
function slugify(s: string, maxWords = 8): string {
  const words = s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);
  return words.join("-") || "request";
}
function uniqueId(base: string): string {
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  ids.add(id);
  return id;
}
function baseRequest(id: string, source: PrayerRequest["source"] = "manual", te_status: PrayerRequest["te_status"] = "human") {
  return { id, status: "active" as const, visibility: "public" as const, source, created_at: CREATED_AT, te_status };
}
const txt = (el: Element | null | undefined): string => (el?.textContent ?? "");
const liTexts = (ul: Element | null): string[] => (ul ? Array.from(ul.querySelectorAll(":scope > li")).map((li) => txt(li)) : []);
const zip = (en: string[], te: string[], where: string): Bi[] => {
  if (en.length !== te.length) throw new Error(`${where}: en has ${en.length} items, te has ${te.length}`);
  return en.map((e, i) => ({ en: e, te: te[i] }));
};
function fail(msg: string): never {
  throw new Error(msg);
}

/** Free-text side: text nodes + <strong> (=> **x**). Anything else is an error. */
function freeText(side: Element, where: string): string {
  let out = "";
  side.childNodes.forEach((n) => {
    if (n.nodeType === 3) out += n.textContent;
    else if (n.nodeType === 1 && (n as Element).tagName === "STRONG") out += `**${n.textContent}**`;
    else fail(`${where}: unexpected <${(n as Element).tagName}> in free-text row`);
  });
  return out;
}

interface Shape {
  hasNote: boolean;
  hasLabel: boolean;
  hasDetail: boolean;
}
interface SideParts {
  name: string;
  note?: string;
  label?: string;
  detail?: string;
  items?: string[];
}

/** Split "[ NOTE][ - LABEL]" into note/label. */
function splitNoteLabel(s: string, where: string, shape?: Shape): { note?: string; label?: string } {
  if (s === "") return {};
  if (s.startsWith(" - ") && (!shape || !shape.hasNote)) return { label: s.slice(3) };
  if (!s.startsWith(" ")) fail(`${where}: expected text after name to start with a space, got ${JSON.stringify(s)}`);
  const i = s.indexOf(" - ", 1);
  const wantLabel = shape ? shape.hasLabel : i >= 0;
  if (wantLabel) {
    if (i < 0) fail(`${where}: expected " - LABEL" in ${JSON.stringify(s)}`);
    return { note: s.slice(1, i), label: s.slice(i + 3) };
  }
  return { note: s.slice(1) };
}

/** EN side of a name row. Detail is inside <span class="detail">. */
function parseEnSide(side: Element, where: string): SideParts {
  const nodes = Array.from(side.childNodes);
  const strong = nodes[0] as Element;
  let tail = "";
  let detail: string | undefined;
  let items: string[] | undefined;
  for (const n of nodes.slice(1)) {
    if (n.nodeType === 3) {
      if (detail !== undefined || items) fail(`${where}: text after detail/list: ${JSON.stringify(n.textContent)}`);
      tail += n.textContent;
    } else if (n.nodeType === 1 && (n as Element).matches("span.detail")) {
      if (detail !== undefined || items) fail(`${where}: unexpected second detail`);
      detail = txt(n as Element);
    } else if (n.nodeType === 1 && (n as Element).matches("ul.pr")) {
      if (items) fail(`${where}: two lists`);
      items = liTexts(n as Element);
    } else fail(`${where}: unexpected node <${(n as Element).tagName}>`);
  }
  let noteLabel = tail;
  if (detail !== undefined) {
    if (tail.endsWith(": ")) {
      noteLabel = tail.slice(0, -2);
      const nl = splitNoteLabel(noteLabel, where);
      if (nl.label === undefined) fail(`${where}: ": " detail separator without label`);
      return { name: txt(strong), ...nl, detail, items };
    } else if (tail.endsWith(" - ")) {
      noteLabel = tail.slice(0, -3);
      const nl = splitNoteLabel(noteLabel, where, { hasNote: noteLabel !== "", hasLabel: false, hasDetail: true });
      return { name: txt(strong), ...nl, detail, items };
    } else fail(`${where}: detail not preceded by ": " or " - " (tail ${JSON.stringify(tail)})`);
  }
  return { name: txt(strong), ...splitNoteLabel(noteLabel, where), items };
}

/** TE side: same structure but detail is plain text; uses EN shape to disambiguate. */
function parseTeSide(side: Element, shape: Shape, where: string): SideParts {
  const nodes = Array.from(side.childNodes);
  const strong = nodes[0] as Element;
  let rest = "";
  let items: string[] | undefined;
  for (const n of nodes.slice(1)) {
    if (n.nodeType === 3) {
      if (items) fail(`${where}: text after list`);
      rest += n.textContent;
    } else if (n.nodeType === 1 && (n as Element).matches("ul.pr")) items = liTexts(n as Element);
    else fail(`${where}: unexpected node <${(n as Element).tagName}> on te side`);
  }
  let detail: string | undefined;
  if (shape.hasDetail) {
    if (shape.hasLabel) {
      const dash = rest.indexOf(" - ");
      const i = rest.indexOf(": ", dash < 0 ? 0 : dash);
      if (dash < 0 || i < 0) fail(`${where}: te expected " - LABEL: DETAIL" in ${JSON.stringify(rest)}`);
      detail = rest.slice(i + 2);
      rest = rest.slice(0, i);
    } else {
      const i = shape.hasNote ? rest.indexOf(" - ", 1) : rest.indexOf(" - ");
      if (i < 0) fail(`${where}: te expected " - DETAIL" in ${JSON.stringify(rest)}`);
      detail = rest.slice(i + 3);
      rest = rest.slice(0, i);
    }
  }
  return { name: txt(strong), ...splitNoteLabel(rest, where, shape), detail, items };
}

function bi(en: string | undefined, te: string | undefined, field: string, where: string): Bi | undefined {
  if (en === undefined && te === undefined) return undefined;
  if (en === undefined || te === undefined) fail(`${where}: ${field} present on one side only (en=${JSON.stringify(en)}, te=${JSON.stringify(te)})`);
  return { en, te };
}

function parseListRow(row: Element, where: string): PrayerRequest {
  const en = row.querySelector(":scope > .en") ?? fail(`${where}: no .en`);
  const te = row.querySelector(":scope > .te") ?? fail(`${where}: no .te`);
  const plain = row.classList.contains("plain");
  const first = en.firstChild;
  const nameRow = !plain && first?.nodeType === 1 && (first as Element).tagName === "STRONG";
  if (!nameRow) {
    const text = { en: freeText(en, where), te: freeText(te, where) };
    return { ...baseRequest(uniqueId(slugify(text.en.replace(/\*\*/g, ""), 6))), ...(plain ? { plain: true } : {}), text };
  }
  const tf = te.firstChild;
  if (!(tf?.nodeType === 1 && (tf as Element).tagName === "STRONG")) fail(`${where}: en starts with <strong> but te does not`);
  const e = parseEnSide(en, where);
  const shape: Shape = { hasNote: e.note !== undefined, hasLabel: e.label !== undefined, hasDetail: e.detail !== undefined };
  const t = parseTeSide(te, shape, where);
  const r: PrayerRequest = { ...baseRequest(uniqueId(slugify(e.name))), name: { en: e.name, te: t.name } };
  const note = bi(e.note, t.note, "note", where);
  const label = bi(e.label, t.label, "label", where);
  const detail = bi(e.detail, t.detail, "detail", where);
  if (note) r.note = note;
  if (label) r.label = label;
  if (detail) r.detail = detail;
  if (e.items || t.items) r.items = zip(e.items ?? [], t.items ?? [], `${where} items`);
  return r;
}

function threeColCell(row: Element, col: string, side: "en" | "te"): Element {
  return row.querySelector(`:scope > .${col} > .${side}`) ?? fail(`row3 missing .${col} > .${side}`);
}

function parseHead(row: Element): Columns {
  const c = (col: string): Bi => ({
    en: txt(threeColCell(row, col, "en").querySelector("strong")),
    te: txt(threeColCell(row, col, "te")),
  });
  return { parents: c("col-p"), children: c("col-k"), prayer: c("col-q") };
}

function parseRow3(row: Element, where: string): PrayerRequest {
  const name = { en: txt(threeColCell(row, "col-p", "en").querySelector("strong")), te: txt(threeColCell(row, "col-p", "te").querySelector("strong")) };
  const children = zip(
    liTexts(threeColCell(row, "col-k", "en").querySelector(":scope > ul")),
    liTexts(threeColCell(row, "col-k", "te").querySelector(":scope > ul")),
    `${where} children`,
  );
  const items = zip(
    liTexts(threeColCell(row, "col-q", "en").querySelector(":scope > ul.pr")),
    liTexts(threeColCell(row, "col-q", "te").querySelector(":scope > ul.pr")),
    `${where} items`,
  );
  return { ...baseRequest(uniqueId(slugify(name.en))), name, children, items };
}

// ---------------------------------------------------------------- local renderer (SPEC rules) for round-trip check
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escBold = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
const ul = (xs: string[], cls = "") => `<ul${cls ? ` class="${cls}"` : ""}>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;

function renderListSide(r: PrayerRequest, side: "en" | "te"): string {
  if (r.text) return escBold(r.text[side]);
  let h = `<strong>${esc(r.name![side])}</strong>`;
  if (r.note) h += ` ${esc(r.note[side])}`;
  if (r.label) h += ` - ${esc(r.label[side])}`;
  if (r.detail) {
    h += r.label ? ": " : " - ";
    h += side === "en" ? `<span class="detail">${esc(r.detail.en)}</span>` : esc(r.detail.te);
  }
  if (r.items) h += ul(r.items.map((i) => i[side]), "pr");
  return h;
}
function renderListRow(r: PrayerRequest): string {
  return `<div class="row${r.plain ? " plain" : ""}"><div class="en">${renderListSide(r, "en")}</div><div class="te">${renderListSide(r, "te")}</div></div>`;
}
function renderRow3(r: PrayerRequest): string {
  const two = (cls: string, en: string, te: string) => `<div class="${cls}"><div class="en">${en}</div><div class="te">${te}</div></div>`;
  return (
    `<div class="row3">` +
    two("col-p", `<strong>${esc(r.name!.en)}</strong>`, `<strong>${esc(r.name!.te)}</strong>`) +
    two("col-k", ul(r.children!.map((c) => c.en)), ul(r.children!.map((c) => c.te))) +
    two("col-q", ul(r.items!.map((c) => c.en), "pr"), ul(r.items!.map((c) => c.te), "pr")) +
    `</div>`
  );
}
function renderHead(c: Columns): string {
  const two = (cls: string, b: Bi) => `<div class="${cls}"><div class="en"><strong>${esc(b.en)}</strong></div><div class="te">${esc(b.te)}</div></div>`;
  return `<div class="row3 head">${two("col-p", c.parents)}${two("col-k", c.children)}${two("col-q", c.prayer)}</div>`;
}
// Original HTML serialised by jsdom does not escape `"` in text; normalise both sides the same way.
const norm = (s: string) => s.replace(/>\s+</g, "><").replace(/&quot;/g, '"').trim();

// ---------------------------------------------------------------- extract
const mismatches: string[] = [];
function check(where: string, original: string, rendered: string) {
  if (norm(original) !== norm(rendered)) mismatches.push(`${where}\n  original: ${norm(original)}\n  rendered: ${norm(rendered)}`);
}

const slides: Slide[] = [];
for (const sec of Array.from(doc.querySelectorAll("section.slide[id^='hdr-']"))) {
  const num = Number(sec.id.slice(4));
  const id = SLIDE_IDS[num] ?? fail(`unknown slide ${sec.id}`);
  const theme = Array.from(sec.classList).find((c) => c.startsWith("s-")) ?? fail(`${sec.id}: no theme class`);
  const glow = sec.getAttribute("data-glow") ?? fail(`${sec.id}: no data-glow`);
  const titleEn = sec.querySelector(".slide-title-en")!;
  const titleTe = sec.querySelector(".slide-title-te")!;
  const title = { en: txt(titleEn), te: txt(titleTe) };
  check(`${id} title.en`, titleEn.innerHTML, esc(title.en));
  check(`${id} title.te`, titleTe.innerHTML, esc(title.te));
  const tdText = txt(sec.querySelector(`#td-${num}`)).trim();
  if (tdText !== "5:00") mismatches.push(`${id}: timer display is ${tdText}, expected 5:00 for 300s`);

  const rowsEl = sec.querySelector(".rows") ?? fail(`${sec.id}: no .rows`);
  const addPanel = rowsEl.id === "req-rows";
  if (addPanel !== !!sec.querySelector(".add-panel")) fail(`${sec.id}: req-rows/add-panel mismatch`);
  const rowEls = Array.from(rowsEl.children);
  const threeCol = rowEls.some((r) => r.classList.contains("row3"));
  let columns: Columns | undefined;
  const requests: PrayerRequest[] = [];
  rowEls.forEach((row, i) => {
    const where = `${id} row ${i + 1}`;
    if (row.classList.contains("row3") && row.classList.contains("head")) {
      columns = parseHead(row);
      check(where + " (head)", row.outerHTML, renderHead(columns));
    } else if (row.classList.contains("row3")) {
      const r = parseRow3(row, where);
      requests.push(r);
      check(where, row.outerHTML, renderRow3(r));
    } else if (row.classList.contains("row")) {
      const r = parseListRow(row, where);
      requests.push(r);
      check(where, row.outerHTML, renderListRow(r));
    } else fail(`${where}: unknown row class "${row.className}"`);
  });

  const slide: Slide = {
    id,
    num,
    title,
    theme: theme as Slide["theme"],
    glow,
    layout: threeCol ? "three-col" : "list",
    timer_seconds: 300,
    ...(columns ? { columns } : {}),
    ...(addPanel ? { add_panel: true } : {}),
    requests,
  };
  slides.push(slide);
}

// ---------------------------------------------------------------- optional CSV
function parseCsv(src: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}
let csvAdded = 0;
if (csvPath) {
  const additional = slides.find((s) => s.id === "additional") ?? fail("no additional slide for CSV rows");
  let rows = parseCsv(readFileSync(csvPath, "utf8").replace(/^﻿/, ""));
  if (rows[0] && rows[0][0]?.trim().toLowerCase() === "en") rows = rows.slice(1);
  for (const [enRaw, teRaw = ""] of rows) {
    const en = enRaw.trim();
    const te = teRaw.trim();
    if (!en) continue;
    additional.requests.push({
      ...baseRequest(uniqueId(slugify(en, 6)), "site", te ? "auto" : "needs_review"),
      text: { en, te },
    });
    csvAdded++;
  }
}

// ---------------------------------------------------------------- report / write
if (mismatches.length) {
  console.error(`ROUND-TRIP MISMATCHES (${mismatches.length}):\n` + mismatches.join("\n\n"));
  process.exit(1);
}

const root: Root = validateRoot({ version: 1, updated_at: CREATED_AT, slides });
writeFileSync(outPath, JSON.stringify(root, null, 2) + "\n", "utf8");

console.log(`round-trip check: OK (all rows re-render identically)`);
for (const s of root.slides) console.log(`  ${s.id.padEnd(11)} hdr-${s.num}  ${s.layout.padEnd(9)} ${String(s.requests.length).padStart(3)} rows`);
console.log(`  total: ${root.slides.reduce((n, s) => n + s.requests.length, 0)} requests${csvPath ? ` (${csvAdded} from CSV)` : ""}`);
console.log(`wrote ${outPath}`);
