"use client";

import { numberBlocks, slugify, tidyTitle, type Article } from "./article";
import { libraryFiles } from "./library-export";
import { isLink } from "./links";
import { answered, notesMarkdown, type NotesMeta } from "./markdown";
import { SAMPLES } from "./samples";
import { loadDoc, useStore } from "./store";
import { zip } from "./zip";

/**
 * Exports from the browser. Notes as Markdown files that drop straight into
 * Obsidian: every text's questions, answers, highlights and the reader's own
 * notes (lib/markdown.ts). And the whole library, texts and all, to read
 * without Gloss (lib/library-export.ts).
 */

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

/** Every text with something in it, one Markdown file each, in a zip. Returns how many files. */
export async function exportAll(): Promise<number> {
  const st = useStore.getState();
  const ids = [...new Set([...Object.keys(st.glosses), ...Object.keys(st.highlights)])].filter(
    (id) => (st.glosses[id]?.length ?? 0) + (st.highlights[id]?.length ?? 0) > 0
  );
  const files: { name: string; text: string }[] = [];
  const taken = new Set<string>();

  for (const id of ids) {
    const item = st.library.find((x) => x.id === id);
    const doc = SAMPLES.find((a) => a.id === id) ?? (await loadDoc(id));
    const title = tidyTitle(item?.title ?? doc?.title ?? id);
    const meta: NotesMeta = {
      title,
      author: doc?.author ?? item?.author,
      published: doc?.published,
      source: doc?.source ?? item?.source,
      url: doc?.sourceUrl,
    };
    const place = doc ? { numbers: numberBlocks(doc.blocks), order: new Map(doc.blocks.map((b, i) => [b.id, i])) } : undefined;
    const glosses = answered(st.glosses[id] ?? []);
    let base = slugify(title);
    for (let k = 2; taken.has(base); k++) base = `${slugify(title)}-${k}`;
    taken.add(base);
    files.push({ name: `Gloss/${base}.md`, text: notesMarkdown(meta, glosses, st.highlights[id] ?? [], place, { frontmatter: true }) });
  }

  if (files.length) download(zip(files), `gloss-notes-${stamp()}.zip`);
  return files.length;
}

/** A text from the account, for one that isn't on this device. Null when there is no account, or it isn't there. Not kept on the device. */
async function accountDoc(id: string): Promise<Article | null> {
  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(id)}`);
    return res.ok ? ((await res.json()) as { doc: Article }).doc : null;
  } catch {
    return null;
  }
}

/**
 * The whole library as a zip to read without Gloss: every text as Markdown with
 * its notes, in a folder per topic, the links, and an index. A text that isn't
 * on this device is fetched from the account. `missing`: texts whose words
 * couldn't be found, exported with their notes alone.
 */
export async function exportLibrary(): Promise<{ texts: number; links: number; missing: number }> {
  const st = useStore.getState();
  const ids = st.library.filter((x) => !isLink(x)).map((x) => x.id);
  const docs = new Map<string, Article>();
  // A few at a time: a big shelf fetched at once would queue behind itself anyway.
  for (let i = 0; i < ids.length; i += 6) {
    await Promise.all(
      ids.slice(i, i + 6).map(async (id) => {
        const doc = (await loadDoc(id)) ?? (await accountDoc(id));
        if (doc) docs.set(id, doc);
      })
    );
  }
  const out = libraryFiles({ library: st.library, docs, samples: SAMPLES, glosses: st.glosses, highlights: st.highlights, briefs: st.briefs, progress: st.progress });
  download(zip(out.files), `gloss-library-${stamp()}.zip`);
  return { texts: out.texts, links: out.links, missing: out.missing };
}
