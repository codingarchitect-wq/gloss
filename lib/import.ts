"use client";

import { textToArticle, wordCount, type Article } from "./article";
import { shelveText } from "./shelving";
import { savePdf, saveDoc, useStore, type LibraryItem } from "./store";

/** `needKey`: the import needs the reader's own OpenRouter key (a long PDF, or free use spent). `file`: the original, kept with a PDF. */
export type ImportResult = { ok: true; article: Article; file?: Blob } | { ok: false; error: string; needKey?: boolean };

/** A link to a PDF is fetched by the server and read here, as if the file had been dropped. */
export async function importFromUrl(raw: string, onProgress?: (p: number, label?: string) => void): Promise<ImportResult> {
  try {
    const res = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: raw.trim(), pdf: true }) });
    if (res.ok && res.headers.get("content-type")?.includes("application/pdf")) {
      const name = decodeURIComponent(res.headers.get("x-file-name") ?? "document.pdf");
      const r = await importFromFile(new File([await res.blob()], name, { type: "application/pdf" }), onProgress);
      if (r.ok) r.article.sourceUrl ??= raw.trim();
      return r;
    }
    const j = (await res.json()) as { article?: Article; error?: string };
    return j.article ? { ok: true, article: j.article } : { ok: false, error: j.error ?? "Could not import that page." };
  } catch {
    return { ok: false, error: "Could not reach the importer. Check your connection." };
  }
}

export async function importFromFile(file: File, onProgress?: (p: number, label?: string) => void): Promise<ImportResult> {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      const { pdfToArticle, PdfError } = await import("./pdf");
      try {
        return { ok: true, article: await pdfToArticle(file, onProgress), file };
      } catch (e) {
        if (e instanceof PdfError) return { ok: false, error: e.message, needKey: e.needKey };
        throw e;
      }
    }
    if (/\.(txt|md|markdown|text)$/.test(name) || file.type.startsWith("text/")) {
      const a = textToArticle(await file.text(), { origin: "file" });
      if (a.title === "Untitled") a.title = file.name.replace(/\.(txt|md|markdown|text)$/i, "").replace(/[_-]+/g, " ");
      a.source = file.name;
      return { ok: true, article: a };
    }
    return { ok: false, error: "Gloss reads PDF, .txt and .md files." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not read that file." };
  }
}

export function importFromText(text: string): ImportResult {
  const a = textToArticle(text, { origin: "paste" });
  return a.blocks.length ? { ok: true, article: a } : { ok: false, error: "There was no readable text in that." };
}

/**
 * Saves an imported article (and a PDF's original file) and puts it on the
 * shelf; then, in the background, the library sorts it onto a topic.
 * `extra`: shelf fields known already, like a starter classic's topic and cover.
 */
export async function keep(a: Article, file?: Blob, extra?: Partial<LibraryItem>): Promise<string | null> {
  if (!a.blocks.length) return "There was no readable text in that.";
  if (!(await saveDoc(a))) return "This browser's storage is full. Remove something from your shelf and try again.";
  // The original is a nicety for reading it again; the text is what matters, so a failure here is quiet.
  if (file) await savePdf(a.id, file);
  // A PDF dropped in as a file has no link the server could fetch it from, so it goes up from here.
  if (file && a.origin === "file" && !a.sourceUrl) void uploadPdf(a.id, file);
  useStore.getState().addToLibrary(a, wordCount(a), extra);
  if (!extra?.topic) void shelveText(a);
  return null;
}

const uploads = new Map<string, Promise<UploadResult>>();

/** "saved"; "off": the server keeps no copies, or not this one (too large, not a PDF); "failed": try again later. */
export type UploadResult = "saved" | "off" | "failed";

/**
 * Send a dropped PDF to the server to keep as the text's original (app/api/originals/[id]). The
 * server takes it once the text itself is there, which the sync does a moment after an import, so
 * a 404 is tried again for a while. One upload per text at a time.
 */
export function uploadPdf(id: string, file: Blob): Promise<UploadResult> {
  let p = uploads.get(id);
  if (!p) {
    p = (async (): Promise<UploadResult> => {
      for (const wait of [3, 7, 20, 30, 60]) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        const res = await fetch(`/api/originals/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: file }).catch(() => null);
        if (res?.status === 201) return "saved";
        // Not there yet (404) or a passing fault: wait and try again. Anything else won't change.
        if (res && res.status !== 404 && (res.status < 500 || res.status === 501)) return "off";
      }
      return "failed";
    })().finally(() => uploads.delete(id));
    uploads.set(id, p);
  }
  return p;
}

export const looksLikeUrl = (s: string) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s.trim()) && !/\s/.test(s.trim());
