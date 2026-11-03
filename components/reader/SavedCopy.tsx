"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { originalKind, type Article } from "@/lib/article";
import { uploadPdf } from "@/lib/import";
import { loadPdf } from "@/lib/store";

type State = "unknown" | "none" | "saving" | "saved" | "off";

const pill =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-rule px-3.5 text-[13px] font-medium text-ink-2 transition-[border-color,color,transform] hover:border-rule-strong hover:text-ink active:scale-[0.97]";

/** A text added this recently may still have its copy on the way. */
const FRESH_MS = 10 * 60_000;

/**
 * Beside the link to the live page: the copy of it this server saved, all of it in one file, or
 * the PDF behind a PDF link (lib/originals.ts). A PDF dropped in as a file has no link: this
 * browser sends it up, if it still has it. Nothing shows where the server doesn't save copies.
 */
export function SavedCopy({ article }: { article: Article }) {
  const [state, setState] = useState<State>("unknown");
  const url = `/api/originals/${encodeURIComponent(article.id)}`;
  const kind = originalKind(article);
  /** A file dropped in (a PDF, or text, which has nothing to keep): only this browser has it. */
  const dropped = kind === null && article.origin === "file";
  const fromPage = kind !== null || dropped;
  const words =
    kind === "pdf" || dropped
      ? { saved: "Saved PDF", saving: "Saving the PDF", save: "Save the PDF", tip: "The PDF as it was published, kept on this machine", ask: "Keep the PDF on this machine" }
      : { saved: "Saved copy", saving: "Saving a copy", save: "Save a copy", tip: "The page as it was built, kept on this machine", ask: "Keep the whole page, as it was built, on this machine" };

  useEffect(() => {
    if (!fromPage) return;
    let live = true;
    fetch(url, { method: "HEAD" })
      .then((r) => {
        if (!live) return;
        if (r.status === 200) setState("saved");
        else if (r.status === 404 && dropped) void sendUp(() => live);
        else if (r.status === 404) setState(Date.now() - (article.addedAt ?? 0) < FRESH_MS ? "saving" : "none");
        else setState("off");
      })
      .catch(() => live && setState("off"));
    return () => {
      live = false;
    };
  }, [url, fromPage, dropped, article.addedAt]);

  /** A dropped file this browser still has goes up to the server; text files and files from other devices show nothing. */
  async function sendUp(live: () => boolean = () => true) {
    const file = await loadPdf(article.id);
    if (!live()) return;
    if (!file) return setState("off");
    setState("saving");
    const r = await uploadPdf(article.id, file);
    if (live()) setState(r === "saved" ? "saved" : r === "off" ? "off" : "none");
  }

  // While a copy is being made, look again every few seconds. A dropped PDF's upload says itself when it's done.
  useEffect(() => {
    if (state !== "saving" || dropped) return;
    const started = Date.now();
    const t = setInterval(async () => {
      const r = await fetch(url, { method: "HEAD" }).catch(() => null);
      if (r?.status === 200) setState("saved");
      else if (Date.now() - started > 5 * 60_000) setState("none");
    }, 4000);
    return () => clearInterval(t);
  }, [state, url, dropped]);

  if (state === "saved")
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className={pill} data-tip={words.tip}>
        {words.saved} <ArrowUpRight size={14} strokeWidth={2} />
      </a>
    );
  if (state === "saving")
    return (
      <span className={`${pill} pointer-events-none text-ink-3`} aria-live="polite">
        <LoaderCircle size={14} strokeWidth={2} className="animate-spin" /> {words.saving}
      </span>
    );
  if (state === "none")
    return (
      <button
        type="button"
        className={pill}
        data-tip={words.ask}
        onClick={async () => {
          if (dropped) return void sendUp();
          setState("saving");
          const r = await fetch(url, { method: "POST" }).catch(() => null);
          if (r?.status === 501) setState("off");
          else if (r?.status !== 202) setState("none");
        }}
      >
        {words.save}
      </button>
    );
  return null;
}
