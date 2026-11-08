/**
 * Markdown, for what leaves Gloss: a text's questions, answers, highlights and
 * the reader's own notes, in reading order (the notebook copies them, the shelf
 * exports them), and a text itself, block by block (the library export,
 * lib/library-export.ts). Shared by the browser and the server.
 */

import { ACTION_QUESTIONS, ACTIONS } from "./actions";
import { clock, undash, type Article, type Block, type Run } from "./article";
import type { Gloss, Highlight, Point, Turn } from "./store";

const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The first turn answers the gloss itself; after that, user and assistant turns alternate. */
export function pairsOf(g: Gloss): { q: string; a?: Turn }[] {
  const pairs: { q: string; a?: Turn }[] = [{ q: capFirst(g.question ?? (g.anchor ? ACTION_QUESTIONS[g.action] : "About the whole text")), a: g.turns[0] }];
  for (const t of g.turns.slice(1)) {
    if (t.role === "user") pairs.push({ q: capFirst(t.content) });
    else pairs[pairs.length - 1].a = t;
  }
  return pairs;
}

export type NotesMeta = { title: string; author?: string; published?: string; source?: string; url?: string };
/** Paragraph numbers and block order, when the text itself is at hand. */
export type Place = { numbers: Map<string, number>; order: Map<string, number> };

type Entry = { kind: "gloss"; g: Gloss } | { kind: "hl"; h: Highlight };

export const yaml = (s: string) => JSON.stringify(s);
export const day = (t: number | Date) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Questions with an answer: a gloss asked and left before anything came back has nothing to keep. */
export const answered = (glosses: Gloss[]) => glosses.filter((g) => g.turns.some((t) => t.content));

export function notesMarkdown(meta: NotesMeta, glosses: Gloss[], highlights: Highlight[], place?: Place, opts: { frontmatter?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.frontmatter) {
    lines.push("---", `title: ${yaml(meta.title)}`);
    if (meta.author) lines.push(`author: ${yaml(meta.author)}`);
    if (meta.published) lines.push(`published: ${yaml(meta.published)}`);
    if (meta.source) lines.push(`source: ${yaml(meta.source)}`);
    if (meta.url) lines.push(`url: ${meta.url}`);
    lines.push("tags: [gloss]", "---", "");
  }
  lines.push(`# ${meta.title}`);
  const by = [meta.author, meta.published].filter(Boolean).join(", ");
  if (by) lines.push(by);
  if (meta.url && !opts.frontmatter) lines.push(meta.url);
  lines.push("", `Notes from Gloss, ${day(Date.now())}`, "");
  lines.push(...notesBody(glosses, highlights, place));
  return lines.join("\n").trim() + "\n";
}

/**
 * Highlights (with their notes) and questions (with their answers), in the
 * order they stand in the text, else the order they were made. `level`: the
 * heading level a question gets.
 */
export function notesBody(glosses: Gloss[], highlights: Highlight[], place?: Place, level = 2): string[] {
  const pos = (e: Entry): Point | null => (e.kind === "hl" ? e.h.anchor.start : e.g.anchor?.start ?? (e.g.at ? { b: e.g.at, o: 0 } : null));
  const entries: Entry[] = [...glosses.map((g) => ({ kind: "gloss" as const, g })), ...highlights.map((h) => ({ kind: "hl" as const, h }))];
  const created = (e: Entry) => (e.kind === "hl" ? e.h.createdAt : e.g.createdAt);
  entries.sort((a, b) => {
    const pa = pos(a);
    const pb = pos(b);
    if (place && pa && pb) {
      const d = (place.order.get(pa.b) ?? 0) - (place.order.get(pb.b) ?? 0);
      if (d) return d;
      if (pa.o !== pb.o) return pa.o - pb.o;
    }
    return created(a) - created(b);
  });
  const num = (b?: string) => (b && place ? place.numbers.get(b) : undefined);
  const hashes = "#".repeat(level);

  const lines: string[] = [];
  for (const e of entries) {
    if (e.kind === "hl") {
      const n = num(e.h.anchor.start.b);
      lines.push(`> ${e.h.anchor.quote.replace(/\n+/g, " ")}`);
      if (n) lines.push(`> (¶${n})`);
      lines.push("");
      if (e.h.note) lines.push(e.h.note.trim(), "");
      continue;
    }
    const g = e.g;
    const n = num(g.anchor?.start.b ?? g.at);
    lines.push(`${hashes} ${g.anchor ? ACTIONS[g.action].label : "Question"}${n ? ` (¶${n})` : ""}`);
    if (g.anchor) lines.push(`> ${g.anchor.quote.replace(/\n+/g, " ")}`, "");
    for (const p of pairsOf(g)) {
      lines.push(`**${p.q}**`, "");
      if (p.a?.content) lines.push(undash(p.a.content), "");
      // Web citations as Markdown footnotes, so [1] in the answer still leads somewhere.
      if (p.a?.content && p.a.sources?.length) lines.push(...p.a.sources.map((x) => `[${x.n}]: ${x.url} "${x.title.replace(/"/g, "'")}"`), "");
    }
  }
  return lines;
}

/** Block order, for putting notes in reading order. No paragraph numbers: the text they'd point into is unnumbered. */
export const orderOf = (doc: Article): Place => ({ numbers: new Map(), order: new Map(doc.blocks.map((b, i) => [b.id, i])) });

/* ---------- a text ---------- */

/**
 * What would turn plain words into Markdown, escaped, and nothing more, so the
 * file still reads as plain text: a `_` inside a word is never emphasis, a `<`
 * only opens a tag before a letter, and brackets only make a link before `(`.
 */
export function escapeMd(s: string): string {
  return s
    .replace(/[\\`*]|<(?=[A-Za-z/!?])/g, "\\$&")
    .replace(/\]\(/g, "]\\(")
    .replace(/(^|\W)_|_(?=\W|$)/g, (m) => m.replace("_", "\\_"));
}

/** What a line could be mistaken for at its start: a heading, a quote, a list item, a rule. */
const lineStart = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/^(\s*)(\d+)([.)]\s)/, "$1$2\\$3").replace(/^(\s*)(#{1,6}\s|>|[-+]\s|={3,}|-{3,})/, "$1\\$2"))
    .join("\n");

function runMd(r: Run): string {
  if (!r.text) return "";
  if (r.code) {
    const fence = r.text.includes("`") ? "``" : "`";
    return `${fence}${r.text.replace(/\n/g, " ")}${fence}`;
  }
  // Spaces stay outside the markers, or *emphasis * isn't emphasis.
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text)!;
  if (!core) return r.text;
  let t = escapeMd(core);
  if (r.strong) t = `**${t}**`;
  if (r.em) t = `*${t}*`;
  if (r.href && /^(https?:|mailto:)/i.test(r.href)) t = `[${t}](<${r.href.replace(/[<>\s]/g, encodeURIComponent)}>)`;
  return lead + t + trail;
}

const runsMd = (runs: Run[]) => lineStart(runs.map(runMd).join("").replace(/\n{2,}/g, "\n"));

function tableMd(rows: string[][], head?: boolean): string {
  const width = Math.max(...rows.map((r) => r.length));
  const row = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => escapeMd((r[i] ?? "").replace(/\s+/g, " ").trim()).replace(/\|/g, "\\|")).join(" | ")} |`;
  // Markdown tables always have a head row: a table without one gets an empty head.
  const [first, ...rest] = head ? rows : [Array(width).fill(""), ...rows];
  return [row(first), `| ${Array(width).fill("---").join(" | ")} |`, ...rest.map(row)].join("\n");
}

function figureMd(b: Block): string {
  const alt = (b.alt ?? "").replace(/[[\]\n]/g, " ").trim();
  const out: string[] = [];
  if (b.video) out.push(`[Video${alt ? `: ${alt}` : ""}](<${b.video}>)`);
  else if (b.src) {
    const img = `![${alt}](<${b.src}>)`;
    out.push(b.href ? `[${img}](<${b.href}>)` : img);
  }
  if (b.runs.length) out.push(`_${runsMd(b.runs).trim()}_`);
  return out.join("\n\n");
}

/** A text's blocks as Markdown. Pictures stay where they were published: they are linked, not copied. */
export function blocksMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  let list = false;
  for (const b of blocks) {
    // A transcript's paragraphs keep their time in the video.
    const at = b.t !== undefined ? `\`${clock(b.t)}\` ` : "";
    let md: string;
    switch (b.type) {
      case "h2":
        md = `## ${at}${runsMd(b.runs).replace(/\n/g, " ")}`;
        break;
      case "h3":
        md = `### ${at}${runsMd(b.runs).replace(/\n/g, " ")}`;
        break;
      case "quote":
        md = (at + runsMd(b.runs)).split("\n").map((l) => `> ${l}`).join("\n");
        break;
      case "li":
        md = `- ${at}${runsMd(b.runs).replace(/\n/g, "\n  ")}`;
        break;
      case "pre": {
        const code = b.runs.map((r) => r.text).join("");
        const fence = code.includes("```") ? "~~~~" : "```";
        md = `${fence}\n${code.replace(/\n+$/, "")}\n${fence}`;
        break;
      }
      case "note":
        md = `_${runsMd(b.runs).trim()}_`;
        break;
      case "figure":
        md = figureMd(b);
        break;
      case "table":
        md = b.rows?.length ? tableMd(b.rows, b.head) : "";
        break;
      default:
        md = at + runsMd(b.runs);
    }
    if (!md.trim()) continue;
    // A list's items stand together; anything else is its own paragraph.
    const item = b.type === "li";
    if (out.length) out.push(item && list ? "\n" : "\n\n");
    out.push(md);
    list = item;
  }
  return out.join("");
}
