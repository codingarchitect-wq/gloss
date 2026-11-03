"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Play } from "lucide-react";
import { wordCount, type Article } from "@/lib/article";
import { readApiKey } from "@/lib/ask";
import { useStore } from "@/lib/store";

type State = "unknown" | "saved" | "saving" | "none" | "off";

/** A video added this recently may still be on its way down. */
const FRESH_MS = 30 * 60_000;

/** Ask the video above a transcript to play from `t` seconds (a paragraph's time, in Block). */
export const seekVideo = (t: number) => window.dispatchEvent(new CustomEvent("gloss:seek", { detail: t }));

const pill =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-rule px-3 text-[12.5px] font-medium text-ink-2 transition-[border-color,color,transform] hover:border-rule-strong hover:text-ink active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60";

/**
 * Above a video's transcript: the video, played from this server's copy (lib/originals.ts) once
 * it is saved, its thumbnail linking to YouTube until then. A paragraph's time plays it from
 * there. A video without captions offers a transcription.
 */
export function VideoPanel({ article }: { article: Article }) {
  const v = article.video!;
  const src = `/api/originals/${encodeURIComponent(article.id)}`;
  const [state, setState] = useState<State>("unknown");
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let live = true;
    fetch(src, { method: "HEAD" })
      .then((r) => {
        if (!live) return;
        if (r.status === 200) setState("saved");
        else if (r.status === 404) setState(Date.now() - (article.addedAt ?? 0) < FRESH_MS ? "saving" : "none");
        else setState("off");
      })
      .catch(() => live && setState("off"));
    return () => {
      live = false;
    };
  }, [src, article.addedAt]);

  // While the video comes down, look again every few seconds.
  useEffect(() => {
    if (state !== "saving") return;
    const started = Date.now();
    const t = setInterval(async () => {
      const r = await fetch(src, { method: "HEAD" }).catch(() => null);
      if (r?.status === 200) setState("saved");
      else if (Date.now() - started > FRESH_MS) setState("none");
    }, 5000);
    return () => clearInterval(t);
  }, [state, src]);

  // A paragraph's time: play from there, here when the video is saved, on YouTube when it isn't.
  useEffect(() => {
    const onSeek = (e: Event) => {
      const t = Math.max(0, Number((e as CustomEvent<number>).detail) || 0);
      const el = ref.current;
      if (!el) {
        window.open(`https://www.youtube.com/watch?v=${v.youtube}&t=${Math.floor(t)}s`, "_blank", "noopener,noreferrer");
        return;
      }
      el.currentTime = t;
      void el.play().catch(() => {});
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener("gloss:seek", onSeek);
    return () => window.removeEventListener("gloss:seek", onSeek);
  }, [v.youtube]);

  return (
    <div className="focus-hide rise mt-8" style={{ animationDelay: "170ms" }}>
      <div className="video-frame">
        {state === "saved" ? (
          <video ref={ref} src={src} poster={article.image} controls playsInline preload="metadata" />
        ) : (
          <a href={`https://www.youtube.com/watch?v=${v.youtube}`} target="_blank" rel="noopener noreferrer" className="video-poster" aria-label="Watch on YouTube">
            {article.image && <img src={article.image} alt="" referrerPolicy="no-referrer" draggable={false} />}
            <span className="video-play" aria-hidden>
              <Play size={22} fill="currentColor" />
            </span>
          </a>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] leading-snug text-ink-3">
        {state === "saving" && (
          <span className="inline-flex items-center gap-1.5" aria-live="polite">
            <LoaderCircle size={13} strokeWidth={2} className="animate-spin" /> Saving the video to this machine (360p)
          </span>
        )}
        {state === "none" && (
          <button
            type="button"
            className={pill}
            onClick={async () => {
              setState("saving");
              const r = await fetch(src, { method: "POST" }).catch(() => null);
              if (r?.status === 501) setState("off");
              else if (r?.status !== 202) setState("none");
            }}
          >
            Save the video
          </button>
        )}
        {state === "off" && <span>Playing on YouTube: this server doesn&apos;t keep videos.</span>}
        <span className="min-w-0 flex-1">{v.captions === "auto" ? "Transcript from YouTube's automatic captions." : v.captions === "manual" ? "Transcript from the video's captions." : v.captions === "transcribed" ? "Transcribed from the video's sound." : ""}</span>
        {v.captions === "none" && <Transcribe article={article} />}
      </div>
    </div>
  );
}

/** For a video YouTube has no captions for: its sound, transcribed through OpenRouter (app/api/transcribe). */
function Transcribe({ article }: { article: Article }) {
  const v = article.video!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // At most about $0.07 an hour of speech; often half that.
  const cost = v.duration ? Math.max(0.01, (v.duration / 3600) * 0.07) : null;

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtube: v.youtube, apiKey: readApiKey() || undefined }),
      });
      const j = (await res.json().catch(() => ({}))) as { blocks?: Article["blocks"]; error?: string; code?: string };
      if (!res.ok || !j.blocks?.length) {
        setError(j.code === "need_key" ? "Transcribing needs your OpenRouter key: add it from the key button at the top." : (j.error ?? `The transcription failed (${res.status}).`));
        return;
      }
      const next: Article = { ...article, blocks: j.blocks, video: { ...v, captions: "transcribed" } };
      if (!(await useStore.getState().replaceText(next, wordCount(next)))) {
        setError("This browser's storage is full. Remove something from your shelf and try again.");
        return;
      }
      window.dispatchEvent(new CustomEvent("gloss:text-replaced", { detail: next }));
    } catch {
      setError("Could not reach the transcriber. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={pill} disabled={busy} onClick={go} data-tip={cost ? `Up to about $${cost.toFixed(2)}, through OpenRouter` : "Through OpenRouter"}>
        {busy ? <LoaderCircle size={13} strokeWidth={2} className="animate-spin" /> : <Mic size={13} strokeWidth={2} />}
        {busy ? "Transcribing, a minute or two" : "Transcribe"}
      </button>
      {error && <span className="basis-full text-[12.5px] text-ink-2">{error}</span>}
    </>
  );
}
