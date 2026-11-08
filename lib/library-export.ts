/**
 * The whole library as files to read without Gloss: every text as Markdown,
 * with its brief, and the reader's highlights, notes and questions after it, in
 * a folder for its topic; the links kept as cards, in one file; and an index of
 * it all. Plain Markdown, that reads as well in a text editor as in Obsidian.
 * The browser makes it from what is on the device (lib/export.ts), the server
 * from the account (app/api/export), for a backup (scripts/backup.sh).
 */

import { displayArticle, readingMinutes, tidyTitle, wordCount, type Article } from "./article";
import { TOPICS, topicOf, type Topic } from "./library";
import { fmtCount, isLink } from "./links";
import { answered, blocksMarkdown, day, escapeMd, notesBody, orderOf, yaml } from "./markdown";
import type { BriefState, Gloss, Highlight, LibraryItem, Progress } from "./store";

export type LibraryData = {
  library: LibraryItem[];
  /** The texts' words, by id. A text without them is exported with its notes alone. */
  docs: Map<string, Article>;
  /** The bundled shelf: a sample goes in when the reader has written in it. */
  samples?: Article[];
  glosses: Record<string, Gloss[]>;
  highlights: Record<string, Highlight[]>;
  briefs: Record<string, BriefState>;
  progress: Record<string, Progress>;
};

export type ExportFile = { name: string; text: string };

type Text = { item: LibraryItem; doc?: Article; path: string };

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** A title as a file name any system takes: no path or reserved characters, and not too long. */
function fileName(title: string): string {
  const t = title
    // Plain quotes: some unzip tools still mangle a name's non-ASCII characters.
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[/\\:*?"<>|#^[\]{}\u0000-\u001f\u201c-\u201f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/, "");
  return t || "Untitled";
}

/** A link's text: brackets would end it early. */
const linkText = (s: string) => escapeMd(s).replace(/[[\]]/g, "\\$&");

/** By topic, in the library's order of topics, newest first within each. */
function byTopic<T extends { item: LibraryItem }>(xs: T[]): { topic: Topic; xs: T[] }[] {
  return TOPICS.map((topic) => ({ topic, xs: xs.filter((x) => topicOf(x.item.topic) === topic.key).sort((a, b) => b.item.addedAt - a.item.addedAt) })).filter((g) => g.xs.length);
}

export function libraryFiles(d: LibraryData, now = new Date()): { files: ExportFile[]; texts: number; links: number; missing: number } {
  const root = `Gloss library ${iso(now.getTime())}`;
  const notesOf = (id: string) => ({ glosses: answered(d.glosses[id] ?? []), highlights: d.highlights[id] ?? [] });
  const wrote = (id: string) => notesOf(id).glosses.length + notesOf(id).highlights.length > 0;

  const own = d.library.filter((x) => !isLink(x));
  const shelved = new Set(own.map((x) => x.id));
  const samples = (d.samples ?? []).filter((a) => !shelved.has(a.id) && wrote(a.id));
  const groups = byTopic([
    ...own.map((item) => ({ item, doc: d.docs.get(item.id) })),
    ...samples.map((a) => ({ item: { id: a.id, title: a.title, author: a.author, source: a.source, words: wordCount(a), origin: "sample" as const, addedAt: 0 }, doc: a })),
  ]);

  // A file per text, named for its title, unique within its folder whatever the case.
  const texts: { topic: Topic; xs: Text[] }[] = groups.map(({ topic, xs }) => {
    const taken = new Set<string>();
    return {
      topic,
      xs: xs.map((x) => {
        const base = fileName(tidyTitle(x.doc?.title || x.item.title));
        let name = base;
        for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base} (${k})`;
        taken.add(name.toLowerCase());
        return { ...x, path: `Texts/${fileName(topic.name)}/${name}.md` };
      }),
    };
  });
  const all = texts.flatMap((g) => g.xs.map((x) => ({ ...x, topic: g.topic })));
  const links = byTopic(d.library.filter(isLink).map((item) => ({ item })));
  const linkCount = links.reduce((n, g) => n + g.xs.length, 0);

  const files: ExportFile[] = [
    { name: "README.md", text: indexMarkdown(texts, linkCount, d, now) },
    ...all.map((x) => ({ name: x.path, text: textMarkdown(x, x.topic, d, notesOf(x.item.id)) })),
  ];
  if (linkCount) files.push({ name: "Links.md", text: linksMarkdown(links, linkCount, now) });
  return { files: files.map((f) => ({ ...f, name: `${root}/${f.name}` })), texts: all.length, links: linkCount, missing: all.filter((x) => !x.doc?.blocks.length).length };
}

const pctOf = (d: LibraryData, id: string) => d.progress[id]?.pct ?? 0;

function indexMarkdown(groups: { topic: Topic; xs: Text[] }[], links: number, d: LibraryData, now: Date): string {
  const n = groups.reduce((k, g) => k + g.xs.length, 0);
  const L = [
    "# Gloss library",
    "",
    `Exported from Gloss on ${day(now)}: ${n} ${n === 1 ? "text" : "texts"}${groups.length ? ` in ${groups.length} ${groups.length === 1 ? "topic" : "topics"}` : ""}${links ? `, and ${links} ${links === 1 ? "link" : "links"}` : ""}.`,
    "",
    "Each text is a Markdown file in Texts, in a folder for its topic, with its brief and your highlights, notes and questions after it." +
      (links ? " The links you kept are in [Links.md](<Links.md>)." : "") +
      " Pictures are linked where they were published, not copied, so they need the internet to show.",
    "",
  ];
  for (const g of groups) {
    L.push(`## ${g.topic.name}`, "");
    for (const x of g.xs) {
      const pct = pctOf(d, x.item.id);
      const facts = [
        x.item.author && escapeMd(x.item.author),
        x.item.words > 0 && `${readingMinutes(x.item.words)} min`,
        pct >= 1 || x.item.finishedAt ? "read" : pct > 0 && `${Math.round(pct * 100)}% read`,
        x.item.favorite && "⭐",
      ].filter(Boolean);
      L.push(`- [${linkText(tidyTitle(x.doc?.title || x.item.title))}](<${x.path}>)${facts.length ? ` · ${facts.join(" · ")}` : ""}`);
    }
    L.push("");
  }
  return L.join("\n").trim() + "\n";
}

function textMarkdown(x: Text, topic: Topic, d: LibraryData, notes: { glosses: Gloss[]; highlights: Highlight[] }): string {
  const { item, doc } = x;
  const title = tidyTitle(doc?.title || item.title);
  const author = doc?.author ?? item.author;
  const source = doc?.source ?? item.source;
  const url = doc?.sourceUrl ?? item.sourceUrl;
  const dek = doc?.dek ?? item.dek;
  const pct = pctOf(d, item.id);

  const L = ["---", `title: ${yaml(title)}`];
  if (author) L.push(`author: ${yaml(author)}`);
  if (doc?.published) L.push(`published: ${yaml(doc.published)}`);
  if (source) L.push(`source: ${yaml(source)}`);
  if (url) L.push(`url: ${yaml(url)}`);
  if (item.addedAt) L.push(`added: ${iso(item.addedAt)}`);
  L.push(`topic: ${yaml(topic.name)}`, `tags: ${JSON.stringify(["gloss", ...(item.tags ?? [])])}`);
  if (pct > 0) L.push(`progress: ${yaml(`${Math.round(Math.min(pct, 1) * 100)}%`)}`);
  if (item.finishedAt) L.push(`finished: ${iso(item.finishedAt)}`);
  if (item.favorite) L.push("favorite: true");
  L.push("---", "", `# ${escapeMd(title)}`, "");

  const by = [author, doc?.published, source].filter(Boolean).map((s) => escapeMd(s!));
  if (by.length) L.push(by.join(" · "), "");
  if (url) L.push(`<${url}>`, "");
  if (dek) L.push(`_${escapeMd(dek)}_`, "");

  const brief = d.briefs[item.id];
  if (brief?.status === "ready") {
    L.push("## In brief", "", escapeMd(brief.data.gist), "");
    if (brief.data.claims.length) L.push(...brief.data.claims.map((c) => `- ${escapeMd(c.text)}`), "");
    if (brief.data.caveats?.length) L.push("Worth keeping in mind:", "", ...brief.data.caveats.map((c) => `- ${escapeMd(c.text)}`), "");
  }

  L.push("* * *", "");
  // Shouting headings brought down to title case, as the reader shows them.
  if (doc?.blocks.length) L.push(blocksMarkdown(displayArticle(doc).blocks), "");
  else L.push(`_The words of this text weren't found when it was exported${url ? ": they are at its link, above" : ""}. Your notes on it are below._`, "");

  if (notes.glosses.length || notes.highlights.length) {
    L.push("* * *", "", "## Your highlights and notes", "", ...notesBody(notes.glosses, notes.highlights, doc ? orderOf(doc) : undefined, 3));
  }
  return L.join("\n").trim() + "\n";
}

function linksMarkdown(groups: { topic: Topic; xs: { item: LibraryItem }[] }[], n: number, now: Date): string {
  const L = ["# Links", "", `${n} ${n === 1 ? "link" : "links"} kept in Gloss, by topic. Exported ${day(now)}.`, ""];
  for (const g of groups) {
    L.push(`## ${g.topic.name}`, "");
    for (const { item: x } of g.xs) {
      const m = x.meta;
      const facts = [
        x.source && escapeMd(x.source),
        m?.stars !== undefined && `★ ${fmtCount(m.stars)}`,
        m?.language && escapeMd(m.language),
        m?.license,
        m?.archived && "archived",
        x.favorite && "⭐",
      ].filter(Boolean);
      const title = `**${x.sourceUrl ? `[${linkText(x.title)}](<${x.sourceUrl}>)` : linkText(x.title)}**`;
      L.push(`- ${title}${facts.length ? ` · ${facts.join(" · ")}` : ""}`);
      if (x.dek) L.push(`  - ${escapeMd(x.dek)}`);
      if (x.note) L.push(`  - Your note: ${escapeMd(x.note.replace(/\s+/g, " ").trim())}`);
      L.push(`  - Kept ${day(x.addedAt)}${x.tags?.length ? ` · ${x.tags.map(escapeMd).join(", ")}` : ""}`);
    }
    L.push("");
  }
  return L.join("\n").trim() + "\n";
}
