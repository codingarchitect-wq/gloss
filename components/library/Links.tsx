"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, ArrowRight, ArrowUpRight, BookOpen, ChevronDown, Download, Globe, Link2, Loader2, RotateCw, Star, Trash2, X } from "lucide-react";
import { looksLikeUrl } from "@/lib/import";
import { keepLink, readAsText, refreshLink } from "@/lib/keep-link";
import { TOPIC, TOPICS, topicOf, type TopicKey } from "@/lib/library";
import { fmtCount, isLink, normalizeUrl } from "@/lib/links";
import type { RepoCopy } from "@/lib/repo-copy";
import { repoOf } from "@/lib/repo-url";
import { useStore, type LibraryItem } from "@/lib/store";
import { Glyph } from "./Book";

/**
 * The library's card catalogue: links kept to find again rather than to read
 * (a repo, a tool, a site), each on an index card with the picture it shares
 * itself with. They live in a drawer beside the shelves, so the shelves stay
 * for reading. A card's title opens its link; anywhere else on it pulls it out,
 * to write a note, move it to another topic, or read the page in as a text.
 */

export type LinkSort = "recent" | "topic" | "az";
export const LINK_SORTS: { key: LinkSort; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "topic", label: "Topic" },
  { key: "az", label: "A–Z" },
];

/** Where a card's link goes, without its scheme: github.com/owner/repo. */
const shortUrl = (url?: string) => (url ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
const hostOf = (url?: string) => shortUrl(url).split("/")[0];

/** GitHub's colours for the languages a repo is most often in. */
const LANG: Record<string, string> = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Python: "#3572a5", Rust: "#dea584", Go: "#00add8", Java: "#b07219", Kotlin: "#a97bff",
  Swift: "#f05138", C: "#555555", "C++": "#f34b7d", "C#": "#178600", Ruby: "#701516", PHP: "#4f5d95", Shell: "#89e051", HTML: "#e34c26",
  CSS: "#663399", "Jupyter Notebook": "#da5b0b", Zig: "#ec915c", Elixir: "#6e4a7e", Haskell: "#5e5086", Lua: "#000080", Dart: "#00b4ab",
  Scala: "#c22d40", Svelte: "#ff3e00", Vue: "#41b883", MDX: "#fcb32c", Nix: "#7e7eff", OCaml: "#ef7a08", Clojure: "#db5855", Julia: "#a270ba",
};

/** Words a link is found by: everything on its card, and the note behind it. */
export const linkWords = (l: LibraryItem) =>
  `${l.title} ${l.dek ?? ""} ${shortUrl(l.sourceUrl)} ${l.source ?? ""} ${TOPIC[topicOf(l.topic)].name} ${(l.tags ?? []).join(" ")} ${l.note ?? ""} ${l.meta?.language ?? ""}`.toLowerCase();

export function sortLinks(links: LibraryItem[], sort: LinkSort): LibraryItem[] {
  const by = [...links];
  if (sort === "az") by.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  else by.sort((a, b) => b.addedAt - a.addedAt);
  return by;
}

/* ---------- one card ---------- */

function Favicon({ src, size = 14 }: { src?: string; size?: number }) {
  const [bad, setBad] = useState(!src);
  if (bad) return <Globe size={size - 1} className="shrink-0 text-ink-4" aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={size} height={size} className="link-favicon" referrerPolicy="no-referrer" draggable={false} onError={() => setBad(true)} />;
}

/** The card's picture: the one the link shares itself with, or its site's icon on the topic's colour. */
function Picture({ link, big }: { link: LibraryItem; big?: boolean }) {
  const [broken, setBroken] = useState(false);
  const [badIcon, setBadIcon] = useState(!link.icon);
  if (link.image && !broken)
    return (
      <div className={`link-thumb${big ? " is-big" : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={link.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} onError={() => setBroken(true)} />
      </div>
    );
  const letter = (hostOf(link.sourceUrl) || link.title).replace(/^www\./, "").charAt(0).toUpperCase();
  return (
    <div className={`link-thumb is-plain${big ? " is-big" : ""}`} aria-hidden>
      {badIcon ? (
        <span className="link-letter">{letter}</span>
      ) : (
        <span className="link-mark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={link.icon} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setBadIcon(true)} />
        </span>
      )}
    </div>
  );
}

function Facts({ link, wide }: { link: LibraryItem; wide?: boolean }) {
  const m = link.meta;
  return (
    <>
      {typeof m?.stars === "number" && (
        <span className="link-fact" aria-label={`${m.stars.toLocaleString("en-US")} stars`}>
          <Star size={12} aria-hidden /> {fmtCount(m.stars)}
        </span>
      )}
      {m?.language && (
        <span className="link-fact">
          <span className="link-lang" style={{ background: LANG[m.language] ?? "var(--ink-4)" }} aria-hidden />
          {m.language}
        </span>
      )}
      {wide && m?.license && <span className="link-fact">{m.license}</span>}
      {m?.archived && <span className="link-fact is-archived">Archived</span>}
    </>
  );
}

export function LinkCard({ link, i = 0, fresh, compact, onOpen }: { link: LibraryItem; i?: number; fresh?: boolean; compact?: boolean; onOpen: (l: LibraryItem) => void }) {
  const t = TOPIC[topicOf(link.topic)];
  const host = hostOf(link.sourceUrl) || link.source || "";
  return (
    <article
      className="link-card"
      data-fresh={fresh || undefined}
      data-compact={compact || undefined}
      style={{ ["--c" as string]: t.shades[0], ["--c-deep" as string]: t.shades[2], ["--i" as string]: i }}
    >
      {/* The whole card pulls it out; only its title goes to the link. */}
      <button type="button" className="link-hit" aria-label={`Open the card for ${link.title}`} onClick={() => onOpen(link)} />
      <Picture link={link} />
      <div className="link-body">
        <p className="link-site">
          <Favicon src={link.icon} />
          <span className="truncate">{host}</span>
        </p>
        <h3 className="link-title">
          <a href={link.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`${link.title}, on ${host} (opens in a new tab)`}>
            {link.title}
          </a>
        </h3>
        <span className="link-rule" aria-hidden />
        {!compact && link.dek && <p className="link-dek">{link.dek}</p>}
        {!compact && link.note && <p className="link-note">{link.note}</p>}
        <p className="link-foot">
          <span className="link-fact">
            <Glyph k={t.key} size={15} /> {t.name}
          </span>
          <Facts link={link} />
          {link.favorite && <span aria-label="Favourite">⭐</span>}
        </p>
      </div>
    </article>
  );
}

/* ---------- the drawer ---------- */

/** Every card, with a slot at the top to keep another: the Links view. */
export function LinkDrawer({
  links,
  total,
  sort,
  q,
  fresh,
  onOpen,
}: {
  links: LibraryItem[];
  total: number;
  sort: LinkSort;
  q: string;
  fresh: Set<string>;
  onOpen: (l: LibraryItem) => void;
}) {
  const sorted = useMemo(() => sortLinks(links, sort), [links, sort]);
  const groups = useMemo(
    () => (sort === "topic" ? TOPICS.map((t) => ({ t, links: sorted.filter((l) => topicOf(l.topic) === t.key) })).filter((g) => g.links.length) : []),
    [sorted, sort]
  );
  let n = 0;
  const card = (l: LibraryItem) => <LinkCard key={l.id} link={l} i={n++} fresh={fresh.has(l.id)} onOpen={onOpen} />;

  return (
    <div className="link-drawer">
      <LinkAdder />
      {total === 0 ? (
        <div className="link-empty">
          <p className="font-serif text-[24px] leading-tight text-ink">An empty drawer, for now</p>
          <p className="mx-auto mt-2 max-w-[440px] text-pretty text-[14px] leading-relaxed text-ink-3">
            Keep repos, tools and sites here: links to find again rather than read. Paste one above, or a whole list from Add articles, where repos and home pages come here on their own.
          </p>
        </div>
      ) : !links.length ? (
        <p className="py-10 text-center text-[14px] text-ink-3">No links match{q.trim() ? <> &ldquo;{q.trim()}&rdquo;</> : ""}.</p>
      ) : sort === "topic" ? (
        groups.map(({ t, links: ls }) => (
          <section key={t.key} className="link-group">
            <h3 className="link-label" style={{ ["--c" as string]: t.shades[0] }}>
              <Glyph k={t.key} size={16} /> {t.name} <span className="lib-n">{ls.length}</span>
            </h3>
            <div className="link-grid">{ls.map(card)}</div>
          </section>
        ))
      ) : (
        <div className="link-grid">{sorted.map(card)}</div>
      )}
    </div>
  );
}

/** The slot in the drawer: paste a link (or a few), and each comes back as a card. */
function LinkAdder() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ bad?: boolean; text: string } | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (busy) return;
    const urls = [...new Set(text.split(/[\s,]+/).filter(looksLikeUrl))];
    if (!urls.length) return setNote(text.trim() ? { bad: true, text: "That doesn't look like a link." } : null);
    setNote(null);
    const said: string[] = [];
    let kept = 0;
    for (const url of urls) {
      const known = useStore.getState().library.find((x) => x.sourceUrl && normalizeUrl(x.sourceUrl) === normalizeUrl(url));
      if (known) {
        said.push(isLink(known) ? `Already in the drawer: ${known.title}.` : `Already on your shelf, as a text: ${known.title}.`);
        continue;
      }
      setBusy(`Reading ${hostOf(url) || url}`);
      const r = await keepLink(url);
      if (r.ok) kept++;
      else said.push(r.error);
    }
    setBusy(null);
    setText("");
    setNote(said.length ? { bad: !kept, text: said.join(" ") } : null);
    ref.current?.focus();
  };

  return (
    <form
      className="link-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="link-add-field">
        {busy ? <Loader2 size={15} className="shrink-0 animate-spin text-ink-3" /> : <Link2 size={15} className="shrink-0 text-ink-4" aria-hidden />}
        <input
          ref={ref}
          value={busy ?? text}
          readOnly={Boolean(busy)}
          onChange={(e) => (setText(e.target.value), setNote(null))}
          placeholder="Paste a link to keep: a repo, a tool, a site"
          aria-label="A link to keep"
          spellCheck={false}
        />
      </label>
      <button type="submit" className="add-btn !mt-0" disabled={Boolean(busy) || !text.trim()}>
        Keep
      </button>
      {note && <p className={`link-add-note${note.bad ? " is-bad" : ""}`}>{note.text}</p>}
    </form>
  );
}

/** A few cards under something else (the shelf's search, a topic's books), with the way to the rest. */
export function LinkStrip({
  title,
  links,
  fresh,
  onOpen,
  onAll,
  max = 6,
  full,
}: {
  title: string;
  links: LibraryItem[];
  fresh?: Set<string>;
  onOpen: (l: LibraryItem) => void;
  onAll?: () => void;
  max?: number;
  /** Whole cards, with their descriptions and notes, rather than the short ones. */
  full?: boolean;
}) {
  if (!links.length) return null;
  const shown = sortLinks(links, "recent").slice(0, max);
  return (
    <section className="link-strip">
      <div className="link-strip-head">
        <h3 className="link-strip-title">
          <Link2 size={15} aria-hidden /> {title} <span className="lib-n">{links.length}</span>
        </h3>
        {onAll && (
          <button type="button" className="lib-back !h-8 !pl-3.5 !pr-3" onClick={onAll}>
            {links.length > shown.length ? `All ${links.length} in Links` : "Open Links"} <ArrowRight size={14} />
          </button>
        )}
      </div>
      <div className="link-grid">
        {shown.map((l, i) => (
          <LinkCard key={l.id} link={l} i={i} compact={!full} fresh={fresh?.has(l.id)} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

/* ---------- a card, pulled out ---------- */

/**
 * One card, out of the drawer: its picture, where it goes, what it is, and
 * the reader's note on it. From here it moves to another topic, is starred,
 * read again, read in as a text, or thrown out. Esc puts it back.
 */
export function LinkPanel({ link, onClose, onRead }: { link: LibraryItem; onClose: () => void; onRead: (textId: string) => void }) {
  const shelve = useStore((s) => s.shelve);
  const remove = useStore((s) => s.removeFromLibrary);
  const [busy, setBusy] = useState<null | "read" | "refresh">(null);
  const [error, setError] = useState<string | null>(null);
  const t = TOPIC[topicOf(link.topic)];

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const read = async () => {
    setBusy("read");
    setError(null);
    const r = await readAsText(link.id);
    if (r.ok) return onRead(r.id);
    setBusy(null);
    setError(r.error);
  };
  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    if (!(await refreshLink(link.id))) setError("Couldn't read the link again just now.");
    setBusy(null);
  };

  const kept = new Date(link.addedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  return createPortal(
    <div className="fixed inset-0 z-[80]" role="presentation">
      <div className="absolute inset-0 bg-ink/20 backdrop-blur-[2px]" style={{ animation: "fade 0.2s both" }} onClick={onClose} />
      <section role="dialog" aria-modal aria-label={link.title} className="link-panel" style={{ ["--c" as string]: t.shades[0], ["--c-deep" as string]: t.shades[2] }}>
        <Picture link={link} big />
        <div className="link-panel-body">
          <div className="ob-kicker">
            <label className="ob-chip" style={{ ["--c" as string]: t.shades[0] }} data-tip="Move to another topic">
              <Glyph k={t.key} size={15} />
              <span>{t.name}</span>
              <ChevronDown size={13} strokeWidth={2.2} className="ob-chip-caret" aria-hidden />
              <select value={topicOf(link.topic)} onChange={(e) => shelve(link.id, { topic: e.target.value as TopicKey })} aria-label="Topic">
                {TOPICS.map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="ob-tools">
              <button
                type="button"
                className="ob-icon"
                aria-pressed={Boolean(link.favorite)}
                aria-label={link.favorite ? "Remove from favourites" : "Add to favourites"}
                data-tip={link.favorite ? "Favourite" : "Add to favourites"}
                onClick={() => shelve(link.id, { favorite: !link.favorite })}
              >
                <Star size={15} fill={link.favorite ? "currentColor" : "none"} />
              </button>
              <button type="button" className="ob-icon" aria-label="Read the link again" data-tip="Read the link again" disabled={Boolean(busy)} onClick={refresh}>
                <RotateCw size={14} className={busy === "refresh" ? "animate-spin" : ""} />
              </button>
              <button
                type="button"
                className="ob-icon"
                aria-label="Remove from the library"
                data-tip="Remove from the library"
                onClick={() => {
                  remove(link.id);
                  onClose();
                }}
              >
                <Trash2 size={14} />
              </button>
              <button type="button" className="ob-icon" aria-label="Close" data-tip="Close" data-tip-kbd="Esc" onClick={onClose}>
                <X size={16} />
              </button>
            </span>
          </div>

          <TitleField key={link.title} title={link.title} onDone={(title) => title && title !== link.title && shelve(link.id, { title })} />
          <a className="link-panel-url" href={link.sourceUrl} target="_blank" rel="noopener noreferrer">
            <Favicon src={link.icon} />
            <span className="truncate">{shortUrl(link.sourceUrl)}</span>
            <ArrowUpRight size={13} className="shrink-0" />
          </a>
          {link.dek && <p className="link-panel-dek">{link.dek}</p>}
          {(link.meta || (link.tags?.length ?? 0) > 0 || link.addedBy === "agent") && (
            <p className="ob-tags">
              <Facts link={link} wide />
              {link.addedBy === "agent" && (
                <span>
                  <Glyph k="agent" size={15} /> Kept by {link.addedVia || "your agent"}
                </span>
              )}
              {(link.tags ?? []).map((x) => (
                <span key={x} className="is-word">
                  {x}
                </span>
              ))}
            </p>
          )}

          <label className="mt-5 block">
            <span className="lib-label">Your note</span>
            <NoteField key={link.note ?? ""} note={link.note ?? ""} onDone={(note) => note !== (link.note ?? "") && shelve(link.id, { note: note || undefined })} />
          </label>

          {repoOf(link.sourceUrl ?? "") && <RepoCopyRow link={link} />}

          {error && <p className="mt-3 text-[12.5px] text-rubric-text">{error}</p>}
          <div className="link-panel-actions">
            <a className="ob-read" href={link.sourceUrl} target="_blank" rel="noopener noreferrer">
              Open link <ArrowUpRight size={16} />
            </a>
            <button type="button" className="link-panel-text" onClick={read} disabled={Boolean(busy)} data-tip="Read the page in, onto the shelf">
              {busy === "read" ? <Loader2 size={15} className="animate-spin" /> : <BookOpen size={15} />}
              {busy === "read" ? "Reading" : "Read as a text"}
            </button>
          </div>
          <p className="link-panel-foot">Kept {kept}</p>
        </div>
      </section>
    </div>,
    document.body
  );
}

type RepoState = { info: RepoCopy | null; saved: boolean; saving: boolean; previous: boolean };

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
const mb = (n?: number) => (n ? `${n < 1e6 ? "<1" : (n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : "");

/**
 * A repo's code, kept on the machine Gloss runs on in case the repo is taken
 * down: the latest commit of its main branch, as a git bundle (lib/repo-copy.ts).
 * Nothing shows where the server keeps no copies.
 */
function RepoCopyRow({ link }: { link: LibraryItem }) {
  const url = `/api/originals/${encodeURIComponent(link.id)}`;
  const [s, setS] = useState<RepoState | "off" | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fetch(`${url}?info`)
      .then(async (r) => live && setS(r.ok ? ((await r.json()) as RepoState) : "off"))
      .catch(() => live && setS("off"));
    return () => {
      live = false;
    };
  }, [url, tick]);

  // A card kept a moment ago has its copy on the way; while one is, look again every few seconds.
  const saving = s !== null && s !== "off" && !s.saved && (s.saving || (!s.info && Date.now() - link.addedAt < 10 * 60_000));
  useEffect(() => {
    if (!saving) return;
    const t = setTimeout(() => setTick((n) => n + 1), 4000);
    return () => clearTimeout(t);
  }, [saving, tick]);

  if (!s || s === "off") return null;
  const i = s.info;
  const save = async () => {
    setS({ ...s, saving: true });
    await fetch(url, { method: "POST" }).catch(() => null);
    setTick((n) => n + 1);
  };

  if (s.saved && i) {
    const host = i.name.split("/")[0];
    const what = `${i.branch} at ${i.commit?.slice(0, 7)}, ${day(i.committedAt)}`;
    return (
      <div className="link-copy" data-gone={i.goneSince ? "" : undefined}>
        <Archive size={17} className="link-copy-icon" aria-hidden />
        <div className="link-copy-text">
          <p className="link-copy-title">{i.goneSince ? `Gone from ${host}. Your copy stays` : "Code saved"}</p>
          <p className="link-copy-sub" title={`Looked at ${day(i.checkedAt)}${i.subject ? `. Its last commit: ${i.subject}` : ""}`}>
            {i.goneSince ? `Missing since ${day(i.goneSince)} · copy of ${what}` : `${what} · ${mb(i.size)}`}
            {s.previous && (
              <>
                {" · "}
                <a href={`${url}?previous`} download data-tip="Kept when the code shrank by half or more">
                  earlier copy
                </a>
              </>
            )}
          </p>
        </div>
        <a className="link-copy-btn" href={url} download data-tip="A git bundle" data-tip-hint="git clone it to get the repo back">
          <Download size={14} aria-hidden /> Download
        </a>
      </div>
    );
  }
  if (saving)
    return (
      <div className="link-copy">
        <Loader2 size={17} className="link-copy-icon animate-spin" aria-hidden />
        <div className="link-copy-text">
          <p className="link-copy-title">Saving the code</p>
          <p className="link-copy-sub">Its main branch as it is now, in case the repo is taken down</p>
        </div>
      </div>
    );
  return (
    <div className="link-copy">
      <Archive size={17} className="link-copy-icon" aria-hidden />
      <div className="link-copy-text">
        <p className="link-copy-title">{i?.error ? "Couldn't save the code" : "Keep a copy of the code"}</p>
        <p className="link-copy-sub">{i?.error ?? "Its main branch as it is now, in case the repo is taken down"}</p>
      </div>
      <button type="button" className="link-copy-btn" onClick={save}>
        {i?.error ? "Try again" : "Save"}
      </button>
    </div>
  );
}

/** The card's title, editable in place: Enter or leaving keeps it, Esc puts the old one back. */
function TitleField({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  return (
    <input
      className="link-panel-title"
      defaultValue={title}
      aria-label="Title"
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.value = title;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => onDone(e.currentTarget.value.replace(/\s+/g, " ").trim().slice(0, 300) || null)}
    />
  );
}

/** Why the link was kept, in the reader's words. Saved on leaving the field. */
function NoteField({ note, onDone }: { note: string; onDone: (note: string) => void }) {
  return (
    <textarea
      className="link-panel-note"
      defaultValue={note}
      rows={2}
      maxLength={600}
      placeholder="Why keep it? A line for later."
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        // Kept before Esc closes the panel: a field taken away while focused never blurs.
        if (e.key === "Escape") e.currentTarget.blur();
      }}
      onBlur={(e) => onDone(e.currentTarget.value.replace(/[ \t]+/g, " ").trim())}
    />
  );
}
