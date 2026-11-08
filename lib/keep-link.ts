"use client";

/**
 * Links kept as cards, from the browser: a repo, a tool, a site saved to the
 * library's Links drawer instead of read onto the shelf. The server reads the
 * link's page for its card (app/api/link); the card goes in the library like
 * any shelf entry, so it syncs the same way, and is sorted onto a topic in the
 * background. A card can become a text to read, and a book a card.
 */

import { forgetCover } from "./covers";
import { importFromUrl, keep } from "./import";
import { linkId, type LinkInfo } from "./links";
import { shelveText } from "./shelving";
import { useStore, type LibraryItem } from "./store";

type Read = { ok: true; link: LinkInfo } | { ok: false; error: string };

async function readLink(url: string): Promise<Read> {
  try {
    const res = await fetch("/api/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: url.trim() }) });
    const j = (await res.json().catch(() => ({}))) as { link?: LinkInfo; error?: string };
    return j.link ? { ok: true, link: j.link } : { ok: false, error: j.error ?? "Could not read that link." };
  } catch {
    return { ok: false, error: "Could not reach Gloss. Check your connection." };
  }
}

const compact = (item: LibraryItem) => {
  for (const k of Object.keys(item) as (keyof LibraryItem)[]) if (item[k] === undefined) delete item[k];
  return item;
};

/** Keep a link as a card. `extra`: what is known already, like a topic. */
export async function keepLink(url: string, extra?: Partial<LibraryItem>): Promise<{ ok: true; id: string; title: string } | { ok: false; error: string }> {
  const r = await readLink(url);
  if (!r.ok) return r;
  const l = r.link;
  const item = compact({
    id: linkId(l.title),
    kind: "link",
    title: l.title,
    source: l.source,
    words: 0,
    origin: "url",
    addedAt: Date.now(),
    dek: l.dek,
    sourceUrl: l.url,
    image: l.image,
    icon: l.icon,
    meta: l.meta,
    ...extra,
  });
  useStore.getState().addLink(item);
  if (!item.topic) void shelveText({ id: item.id, title: item.title, source: item.source, dek: item.dek, kind: "link" });
  return { ok: true, id: item.id, title: item.title };
}

/** Read a card's link again: a repo's stars move, a site changes its picture. What the reader changed stays. */
export async function refreshLink(id: string): Promise<boolean> {
  const x = useStore.getState().library.find((i) => i.id === id);
  if (!x?.sourceUrl) return false;
  const r = await readLink(x.sourceUrl);
  if (!r.ok) return false;
  useStore.getState().shelve(id, { image: r.link.image ?? x.image, icon: r.link.icon ?? x.icon, meta: r.link.meta ?? x.meta, dek: x.dek ?? r.link.dek });
  return true;
}

/**
 * A card's link, read in as a text to put on the shelf. The text keeps the
 * card's topic, tags and star, and the card leaves the drawer. Returns the text's id.
 */
export async function readAsText(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const x = useStore.getState().library.find((i) => i.id === id);
  if (!x?.sourceUrl) return { ok: false, error: "This card has no link." };
  const r = await importFromUrl(x.sourceUrl);
  if (!r.ok) return { ok: false, error: r.notArticle ? "There's no article on that page to read. It stays a link." : r.error };
  const err = await keep(r.article, r.file, { topic: x.topic, tags: x.tags, favorite: x.favorite });
  if (err) return { ok: false, error: err };
  useStore.getState().removeFromLibrary(id);
  return { ok: true, id: r.article.id };
}

/**
 * A book that was never for reading (a repo's README, a tool's home page) put
 * in the drawer as a card, with its topic, tags and star. Its text goes. The
 * page is read again afterwards for the card's icon, and a repo's stars.
 */
export function keepAsLink(id: string): string | null {
  const st = useStore.getState();
  const x = st.library.find((i) => i.id === id);
  if (!x?.sourceUrl) return null;
  const item = compact({
    id: linkId(x.title),
    kind: "link",
    title: x.title,
    source: x.source,
    words: 0,
    origin: "url",
    addedAt: x.addedAt,
    dek: x.dek,
    sourceUrl: x.sourceUrl,
    image: x.image,
    topic: x.topic,
    tags: x.tags,
    favorite: x.favorite,
    addedBy: x.addedBy,
    addedVia: x.addedVia,
  });
  st.addLink(item);
  st.removeFromLibrary(x.id);
  void forgetCover(x.id);
  void refreshLink(item.id);
  return item.id;
}
