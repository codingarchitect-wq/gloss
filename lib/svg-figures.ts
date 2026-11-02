/**
 * Diagrams drawn as inline <svg>, kept as pictures. Runs on the raw page, after
 * prepareImages and before Readability. Server-side only.
 *
 * Many essays draw their charts straight into the page as <svg> rather than
 * linking an image, and the reader used to keep only their captions. A drawing
 * lifted out of its page loses the page's CSS, though: colours set by classes
 * or CSS variables, and the rules that show a wide version on a desktop and a
 * narrow one on a phone. So, as a browser would for a desktop window in light
 * mode, the page's stylesheets are read, matched against the page itself, and
 * what each diagram needs is written into it: its paint, its fonts, CSS
 * variables resolved, and the background it sat on. Only the version a desktop
 * reader would see is kept. Each becomes a self-contained, sanitised
 * data:image/svg+xml picture, with its caption.
 */

import postcss, { type Container } from "postcss";
import { CHROME, hasJunkAncestor } from "./images";
import { publicFetch } from "./public-net";

type El = Element;
type Decl = { prop: string; value: string; important: boolean };
type CssRule = { sel: string; spec: number; order: number; decls: Decl[] };

/** The window a page is laid out for here: a desktop, in light mode. */
const VIEWPORT = { width: 1280, height: 800 };
const MAX_SHEETS = 8;
const MAX_SHEET_BYTES = 1_500_000;
const SHEET_TIMEOUT_MS = 6000;
const MAX_SVG_BYTES = 400_000;
const MAX_ARTICLE_SVG_BYTES = 2_500_000;

/** CSS properties that change how a drawing looks. */
const PAINT = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "color", "font", "font-family", "font-size", "font-weight",
  "font-style", "font-variant", "font-stretch", "letter-spacing", "word-spacing", "text-anchor", "dominant-baseline",
  "alignment-baseline", "baseline-shift", "text-decoration", "white-space", "display", "visibility", "marker", "marker-start",
  "marker-mid", "marker-end", "stop-color", "stop-opacity", "paint-order", "vector-effect", "shape-rendering", "text-rendering",
  "mix-blend-mode", "isolation", "filter", "clip-path", "clip-rule", "mask", "transform", "transform-origin", "transform-box",
  "flood-color", "flood-opacity", "lighting-color", "rx", "ry", "cx", "cy", "r", "x", "y", "width", "height",
]);
/** Of those, the ones a drawing takes from the page around it. */
const INHERITED = new Set([
  "color", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "font", "font-family", "font-size", "font-weight", "font-style",
  "font-variant", "font-stretch", "letter-spacing", "word-spacing", "text-anchor", "dominant-baseline", "paint-order",
  "white-space", "text-rendering", "shape-rendering", "marker", "marker-start", "marker-mid", "marker-end", "clip-rule",
]);
/** The page lays out the drawing's own box; standing alone, it sizes itself. */
const ROOT_LAYOUT = new Set(["width", "height", "x", "y", "transform", "transform-origin", "display", "visibility"]);
/** What the page only shows on a gesture, never in a still picture. */
const DYNAMIC = /::|:(hover|focus|focus-within|focus-visible|active|visited|target|checked|disabled|enabled|placeholder|-webkit-|-moz-)/i;

/** The parser lowercases names; a standalone SVG needs them as written. */
const SVG_CASE = new Map(
  [
    "altGlyph", "altGlyphDef", "altGlyphItem", "animateColor", "animateMotion", "animateTransform", "clipPath", "feBlend",
    "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap",
    "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage",
    "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile",
    "feTurbulence", "glyphRef", "linearGradient", "radialGradient", "textPath",
  ].map((n) => [n.toLowerCase(), n])
);
const DROP = new Set(["script", "foreignobject", "iframe", "object", "embed", "audio", "video", "canvas", "noscript", "template", "handler", "set"]);

/* ---------- finding diagrams ---------- */

function sizeOf(svg: El): { w: number; h: number; box: number[] | null } {
  const v = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const box = v.length === 4 && v.every(Number.isFinite) && v[2] > 0 && v[3] > 0 ? v : null;
  const num = (a: string | null) => (a && /^\s*\d+(\.\d+)?(px)?\s*$/.test(a) ? parseFloat(a) : 0);
  return { w: num(svg.getAttribute("width")) || box?.[2] || 0, h: num(svg.getAttribute("height")) || box?.[3] || 0, box };
}

/** A drawing that belongs to the article: big enough, in a figure or named, and not page furniture. */
function isDiagram(svg: El): boolean {
  if (svg.parentElement?.closest("svg")) return false;
  const { w, h } = sizeOf(svg);
  if (w < 200 || h < 60) return false;
  if (svg.closest(CHROME) || svg.closest("a, button") || hasJunkAncestor(svg)) return false;
  const named = svg.getAttribute("role") === "img" || svg.querySelector("title") || svg.hasAttribute("aria-label") || svg.hasAttribute("aria-labelledby");
  return Boolean(svg.closest("figure") || named);
}

/* ---------- the page's CSS ---------- */

async function readCapped(res: Response | Awaited<ReturnType<typeof publicFetch>>, max: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Every stylesheet the page applies, in document order: <style> blocks and linked sheets. */
async function pageCss(doc: Document, base: string, ua: string): Promise<string[]> {
  const nodes = Array.from(doc.querySelectorAll("style, link[rel~=stylesheet]"));
  let links = 0;
  const jobs = nodes.map((n): Promise<string | null> | string | null => {
    if (n.tagName.toUpperCase() === "STYLE") return n.textContent ?? "";
    const media = n.getAttribute("media");
    if ((media && !mediaMatches(media)) || links >= MAX_SHEETS) return null;
    let url: URL;
    try {
      url = new URL(n.getAttribute("href") ?? "", base);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    links++;
    return publicFetch(url, { signal: AbortSignal.timeout(SHEET_TIMEOUT_MS), headers: { "User-Agent": ua, Accept: "text/css,*/*;q=0.1" } })
      .then((res) => (res.ok && !/html/i.test(res.headers.get("content-type") ?? "") ? readCapped(res, MAX_SHEET_BYTES) : null))
      .catch(() => null);
  });
  return (await Promise.all(jobs)).filter((s): s is string => Boolean(s));
}

/** Does a media query hold for a desktop window in light mode? Unknown features are taken to hold. */
export function mediaMatches(query: string): boolean {
  return query.split(",").some((part) => {
    let q = part.trim().toLowerCase();
    if (!q) return true;
    const negate = /^not\s/.test(q);
    q = q.replace(/^(not|only)\s+/, "");
    const holds = mediaHolds(q);
    return negate ? !holds : holds;
  });
}

const px = (v: string): number | null => {
  const m = /^(-?\d*\.?\d+)\s*(px|em|rem)?$/.exec(v.trim());
  return m ? Number(m[1]) * (m[2] === "em" || m[2] === "rem" ? 16 : 1) : null;
};

function mediaHolds(q: string): boolean {
  const type = /^(all|screen|print|speech|tv|handheld)\b/.exec(q)?.[1];
  if (type && type !== "all" && type !== "screen") return false;
  for (const m of q.matchAll(/\(\s*([a-z-]+)\s*(?::\s*([^)]+))?\)/g)) {
    const [, feature, raw] = m;
    const v = raw?.trim();
    const size = feature.endsWith("width") ? VIEWPORT.width : VIEWPORT.height;
    switch (feature) {
      case "prefers-color-scheme":
        if (v !== "light") return false;
        break;
      case "prefers-reduced-motion":
      case "prefers-contrast":
      case "forced-colors":
        if (v && !/^(no-preference|none)$/.test(v)) return false;
        break;
      case "min-width":
      case "min-height":
        if (v && (px(v) ?? 0) > size) return false;
        break;
      case "max-width":
      case "max-height":
        if (v && (px(v) ?? Infinity) < size) return false;
        break;
      case "orientation":
        if (v === "portrait") return false;
        break;
      case "hover":
      case "any-hover":
        if (v === "none") return false;
        break;
      case "pointer":
      case "any-pointer":
        if (v === "none" || v === "coarse") return false;
        break;
    }
  }
  // Range syntax: (width >= 600px), (400px < width <= 900px).
  for (const m of q.matchAll(/\(([^():]*[<>][^():]*)\)/g)) {
    const parts = m[1].split(/(<=|>=|<|>)/).map((s) => s.trim());
    for (let i = 0; i + 2 < parts.length; i += 2) {
      const [a, op, b] = [parts[i], parts[i + 1], parts[i + 2]];
      const val = (s: string) => (s === "width" ? VIEWPORT.width : s === "height" ? VIEWPORT.height : px(s));
      const x = val(a);
      const y = val(b);
      if (x === null || y === null) continue;
      if ((op === "<" && !(x < y)) || (op === "<=" && !(x <= y)) || (op === ">" && !(x > y)) || (op === ">=" && !(x >= y))) return false;
    }
  }
  return true;
}

function specificity(sel: string): number {
  const s = sel.replace(/:where\([^()]*\)/g, " ").replace(/:(not|is|has)\(([^()]*)\)/g, " $2 ");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g) ?? []).length;
  const types = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g, " ").match(/(^|[\s>+~(])[a-z][\w-]*/gi) ?? []).length;
  return ids * 1_000_000 + classes * 1000 + types;
}

/** The rightmost part of a selector, for finding the rules that could match an element. */
function keyOf(sel: string): string {
  const flat = sel.replace(/\([^()]*\)/g, "()").replace(/\[[^\]]*\]/g, "[]");
  const last = flat.trim().split(/[\s>+~]+/).pop() ?? "";
  const id = /#([\w-]+)/.exec(last)?.[1];
  const cls = /\.([\w-]+)/.exec(last)?.[1];
  const tag = /^([a-z][\w-]*)/i.exec(last)?.[1];
  return id ? `#${id}` : cls ? `.${cls}` : tag ? tag.toLowerCase() : "*";
}

class Styles {
  private index = new Map<string, CssRule[]>();

  constructor(sheets: string[]) {
    let order = 0;
    const walk = (node: Container) => {
      node.each((child) => {
        if (child.type === "rule") {
          const decls: Decl[] = [];
          child.each((d) => {
            if (d.type !== "decl") return;
            const prop = d.prop.startsWith("--") ? d.prop : d.prop.toLowerCase();
            if (prop.startsWith("--") || PAINT.has(prop) || prop === "background" || prop === "background-color" || prop === "overflow") decls.push({ prop, value: d.value, important: d.important });
          });
          if (!decls.length) return;
          for (const raw of child.selectors) {
            const sel = raw.trim();
            if (!sel || DYNAMIC.test(sel) || sel.includes("&")) continue;
            const rule = { sel, spec: specificity(sel), order: order++, decls };
            const key = keyOf(sel);
            this.index.set(key, [...(this.index.get(key) ?? []), rule]);
          }
        } else if (child.type === "atrule") {
          const name = child.name.toLowerCase();
          if (name === "media" && !mediaMatches(child.params)) return;
          if (["media", "supports", "layer", "container", "scope", "document"].includes(name) && child.nodes) walk(child);
        }
      });
    };
    for (const css of sheets) {
      try {
        walk(postcss.parse(css));
      } catch {
        // A sheet the parser can't read is skipped, like a browser skipping a bad rule.
      }
    }
  }

  /** The declarations that apply to an element, after the cascade, inline style included. */
  of(el: El): Map<string, Decl> {
    const keys = ["*", (el.localName ?? el.tagName).toLowerCase()];
    if (el.id) keys.push(`#${el.id}`);
    for (const c of (el.getAttribute("class") ?? "").split(/\s+/)) if (c) keys.push(`.${c}`);
    const hits: CssRule[] = [];
    const seen = new Set<CssRule>();
    for (const k of keys)
      for (const r of this.index.get(k) ?? []) {
        if (seen.has(r)) continue;
        seen.add(r);
        try {
          if (el.matches(r.sel)) hits.push(r);
        } catch {}
      }
    hits.sort((a, b) => a.spec - b.spec || a.order - b.order);
    const out = new Map<string, Decl>();
    const put = (d: Decl) => {
      if (out.get(d.prop)?.important && !d.important) return;
      out.set(d.prop, d);
    };
    for (const r of hits) for (const d of r.decls) put(d);
    for (const d of inlineDecls(el.getAttribute("style"))) put(d);
    return out;
  }
}

function inlineDecls(style: string | null): Decl[] {
  if (!style?.trim()) return [];
  try {
    const out: Decl[] = [];
    postcss.parse(`x{${style}}`).walkDecls((d) => {
      out.push({ prop: d.prop.startsWith("--") ? d.prop : d.prop.toLowerCase(), value: d.value, important: d.important });
    });
    return out;
  } catch {
    return [];
  }
}

/** Substitutes var(--x, fallback). Strict: null when a variable can't be found. Lenient: leaves it be. */
function resolveVars(value: string, vars: Map<string, string>, lenient = false, depth = 0): string | null {
  if (!value.includes("var(")) return value;
  if (depth > 8) return lenient ? value : null;
  let out = "";
  let i = 0;
  while (i < value.length) {
    const j = value.indexOf("var(", i);
    if (j < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, j);
    let k = j + 4;
    for (let d = 1; k < value.length && d; k++) d += value[k] === "(" ? 1 : value[k] === ")" ? -1 : 0;
    const inner = value.slice(j + 4, k - 1);
    let comma = -1;
    for (let p = 0, d = 0; p < inner.length; p++) {
      if (inner[p] === "(") d++;
      else if (inner[p] === ")") d--;
      else if (inner[p] === "," && d === 0) {
        comma = p;
        break;
      }
    }
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const sub = vars.get(name) ?? (comma < 0 ? null : inner.slice(comma + 1).trim());
    const resolved = sub === null ? null : resolveVars(sub, vars, lenient, depth + 1);
    if (resolved === null) {
      if (!lenient) return null;
      out += value.slice(j, k);
    } else out += resolved;
    i = k;
  }
  return out;
}

const withVars = (vars: Map<string, string>, decls: Map<string, Decl>) => {
  let next = vars;
  for (const [prop, d] of decls)
    if (prop.startsWith("--")) {
      if (next === vars) next = new Map(vars);
      next.set(prop, d.value.trim());
    }
  return next;
};

/** Whether a colour lets what is behind it show through: an alpha below 1, or none at all. */
function seeThrough(colour: string): boolean {
  if (/^(transparent|currentcolor)$/.test(colour) || colour.startsWith("color-mix(")) return true;
  const hex = /^#([0-9a-f]{3,8})$/.exec(colour)?.[1];
  if (hex) return (hex.length === 4 && hex[3] !== "f") || (hex.length === 8 && hex.slice(6) !== "ff");
  const args = /^[a-z-]+\((.*)\)$/.exec(colour)?.[1];
  if (args === undefined) return false;
  // rgb(0 0 0 / 3%) puts alpha after a slash; rgba(0, 0, 0, 0.03) makes it a fourth value.
  const bySlash = args.split("/");
  const commas = args.split(",");
  const alpha = bySlash.length === 2 ? bySlash[1] : commas.length === 4 ? commas[3] : undefined;
  if (alpha === undefined) return false;
  const n = parseFloat(alpha);
  if (!Number.isFinite(n)) return true;
  return (alpha.trim().endsWith("%") ? n / 100 : n) < 1;
}

/**
 * A background that is a solid, opaque colour: not a picture, and not a tint meant to be laid over the
 * page (rgb(0 0 0 / 3%)), which would turn dark on the reader's night paper. A tint defers to what is behind it.
 */
function solidBackground(decls: Map<string, Decl>, vars: Map<string, string>): string | null {
  for (const prop of ["background-color", "background"]) {
    const d = decls.get(prop);
    if (!d) continue;
    const v = resolveVars(d.value, vars)?.trim().toLowerCase();
    if (!v || /url\(|gradient\(|^(none|inherit|initial|unset)$/.test(v)) continue;
    const colour = prop === "background" ? v.split(/\s+(?![^(]*\))/).find((t) => /^(#|rgb|hsl|oklch|oklab|lab|lch|color\()|^[a-z]+$/.test(t) && !/^(none|repeat|no-repeat|center|top|bottom|left|right|fixed|scroll|cover|contain|auto)$/.test(t)) : v;
    if (colour && !seeThrough(colour)) return colour;
  }
  return null;
}

/* ---------- making one drawing stand alone ---------- */

/** Hidden on a desktop: by its own rules, or a wrapper's, up to its figure. */
function hiddenOnDesktop(svg: El, styles: Styles, until: El | null): boolean {
  for (let e: El | null = svg; e && e !== until; e = e.parentElement) {
    const d = styles.of(e);
    if (d.get("display")?.value.trim() === "none" || /^(hidden|collapse)$/.test(d.get("visibility")?.value.trim() ?? "")) return true;
  }
  return false;
}

/**
 * Writes the page's styling into the drawing itself; returns the colour it sat on. `drawing` false: a
 * piece the drawing borrows from elsewhere on the page (a sprite's symbol), which takes nothing from
 * the page around it, since where it is used decides that.
 */
function bake(svg: El, styles: Styles, drawing = true): string {
  const chain: El[] = [];
  for (let p = svg.parentElement; p; p = p.parentElement) chain.unshift(p);
  let vars = new Map<string, string>();
  const inherited = new Map<string, string>();
  let background = "#ffffff";
  for (const el of chain) {
    const d = styles.of(el);
    vars = withVars(vars, d);
    for (const [prop, decl] of d) {
      if (!INHERITED.has(prop)) continue;
      const v = resolveVars(decl.value, vars);
      if (v && !/^(inherit|unset|initial)$/.test(v.trim())) inherited.set(prop, v);
    }
    background = solidBackground(d, vars) ?? background;
  }

  const visit = (el: El, parentVars: Map<string, string>) => {
    const d = styles.of(el);
    const own = withVars(parentVars, d);
    const css: string[] = [];
    if (drawing && el === svg) for (const [prop, v] of inherited) if (!d.has(prop)) css.push(`${prop}:${v}`);
    for (const [prop, decl] of d) {
      if (!PAINT.has(prop) || (drawing && el === svg && ROOT_LAYOUT.has(prop))) continue;
      const v = resolveVars(decl.value, own);
      if (v !== null) css.push(`${prop}:${v}${decl.important ? " !important" : ""}`);
    }
    if (css.length) el.setAttribute("style", css.join(";"));
    else el.removeAttribute("style");
    for (const name of el.getAttributeNames()) {
      const v = el.getAttribute(name);
      if (name === "style" || !v?.includes("var(")) continue;
      const r = resolveVars(v, own);
      if (r === null) el.removeAttribute(name);
      else el.setAttribute(name, r);
    }
    if ((el.localName ?? el.tagName).toLowerCase() === "style") el.textContent = resolveVars(el.textContent ?? "", own, true) ?? "";
    for (const child of Array.from(el.children)) visit(child, own);
  };
  visit(svg, vars);
  return background;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");
const safeRef = (v: string, tag: string) => v.startsWith("#") || (tag === "image" && /^data:image\/(png|jpe?g|gif|webp);/i.test(v));
const stripUrls = (css: string) => css.replace(/@import[^;]*;?/gi, "").replace(/url\(\s*(['"]?)(?!#|data:image\/(png|jpe?g|gif|webp);)[^)]*\1\s*\)/gi, "none");

/** XML for a standalone image: SVG names as written, no scripts, handlers or outside references. */
function serialize(node: Node, root: boolean): string {
  if (node.nodeType === 3 || node.nodeType === 4) return escText(node.textContent ?? "");
  if (node.nodeType !== 1) return "";
  const el = node as El;
  const tag = (el.localName ?? el.tagName).toLowerCase();
  if (DROP.has(tag)) return "";
  const inner = Array.from(el.childNodes)
    .map((c) => serialize(c, false))
    .join("");
  if (tag === "a") return inner;
  const attrs: string[] = [];
  for (const name of el.getAttributeNames()) {
    const lower = name.toLowerCase();
    let v = el.getAttribute(name) ?? "";
    if (lower.startsWith("on") || /javascript:/i.test(v) || (root && (lower === "xmlns" || lower === "xmlns:xlink"))) continue;
    if (lower === "href" || lower === "xlink:href" || lower === "src") {
      if (!safeRef(v, tag)) {
        if (tag === "image" || tag === "use" || tag === "feimage") return "";
        continue;
      }
    }
    if (lower === "style") v = stripUrls(v);
    else if (/url\(/i.test(v)) v = stripUrls(v);
    attrs.push(`${name}="${escAttr(v)}"`);
  }
  if (root) attrs.unshift('xmlns="http://www.w3.org/2000/svg"', 'xmlns:xlink="http://www.w3.org/1999/xlink"');
  const name = SVG_CASE.get(tag) ?? tag;
  const body = tag === "style" ? escText(stripUrls(el.textContent ?? "")) : inner;
  return `<${name}${attrs.length ? " " + attrs.join(" ") : ""}>${body}</${name}>`;
}

function altOf(svg: El, doc: Document): string | undefined {
  const label = svg.getAttribute("aria-label");
  const by = (svg.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => (id ? doc.getElementById(id)?.textContent : "") ?? "")
    .join(". ");
  const own = [svg.querySelector("title")?.textContent, svg.querySelector("desc")?.textContent].filter(Boolean).join(". ");
  const alt = (label || by || own).replace(/\s+/g, " ").trim();
  return alt ? alt.slice(0, 400) : undefined;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_BORROWED = 80;

/** Every id an element points at: <use href="#x">, url(#x) in attributes and in <style>. */
function refsOf(el: El): string[] {
  const ids = new Set<string>();
  const scan = (v: string | null) => {
    for (const m of (v ?? "").matchAll(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/g)) ids.add(m[1]);
  };
  for (const e of [el, ...Array.from(el.querySelectorAll("*"))]) {
    for (const name of e.getAttributeNames()) {
      const v = e.getAttribute(name);
      if ((name === "href" || name === "xlink:href") && v?.startsWith("#")) ids.add(v.slice(1));
      else scan(v);
    }
    if ((e.localName ?? e.tagName).toLowerCase() === "style") scan(e.textContent);
  }
  return [...ids];
}

/**
 * Pieces the drawing uses from elsewhere on the page, copied into it: symbols from a shared sprite
 * (people, icons), patterns, gradients and markers. Each is styled where it lives, then copied, and
 * whatever it points at in turn comes too.
 */
function borrow(svg: El, styles: Styles, doc: Document) {
  const inside = new Set<string>();
  for (const e of [svg, ...Array.from(svg.querySelectorAll("[id]"))]) if (e.id) inside.add(e.id);
  let defs: El | null = null;
  const queue = refsOf(svg);
  for (let n = 0; queue.length && n < MAX_BORROWED; ) {
    const id = queue.shift()!;
    if (inside.has(id)) continue;
    const target = doc.getElementById(id);
    if (!target || target.contains(svg)) continue;
    bake(target, styles, false);
    const copy = target.cloneNode(true) as El;
    if (!defs) {
      defs = doc.createElementNS(SVG_NS, "defs");
      svg.insertBefore(defs, svg.firstChild);
    }
    defs.appendChild(copy);
    for (const e of [copy, ...Array.from(copy.querySelectorAll("[id]"))]) if (e.id) inside.add(e.id);
    queue.push(...refsOf(copy));
    n++;
  }
}

/** One diagram as a standalone picture, or null when it is too big to keep. */
function toPicture(svg: El, styles: Styles, doc: Document): { src: string; alt?: string; w: number; h: number } | null {
  const alt = altOf(svg, doc);
  // Read before bake rewrites the drawing's style: does the page let it spill past its own box?
  const spills = /^visible\b/.test(styles.of(svg).get("overflow")?.value.trim() ?? "");
  const background = bake(svg, styles);
  borrow(svg, styles, doc);
  const size = sizeOf(svg);
  let [x0, y0, bw, bh] = size.box ?? [0, 0, size.w, size.h];
  let { w, h } = size;
  // It does: labels may reach past the edges, so the standalone picture gets a margin to hold them.
  if (spills) {
    const [px, py] = [bw * 0.06, bh * 0.04];
    [x0, y0, w, h] = [x0 - px, y0 - py, w * (1 + (2 * px) / bw), h * (1 + (2 * py) / bh)];
    [bw, bh] = [bw + 2 * px, bh + 2 * py];
  }
  svg.setAttribute("viewBox", `${x0} ${y0} ${bw} ${bh}`);
  svg.setAttribute("width", String(Math.round(w)));
  svg.setAttribute("height", String(Math.round(h)));
  // The page it sat on, so it stays legible on the reader's dark paper too.
  const backdrop = doc.createElementNS(SVG_NS, "rect");
  for (const [k, v] of [["x", x0], ["y", y0], ["width", bw], ["height", bh], ["fill", background]] as const) backdrop.setAttribute(k, String(v));
  svg.insertBefore(backdrop, svg.firstChild);
  const xml = serialize(svg, true);
  if (xml.length > MAX_SVG_BYTES) return null;
  return { src: `data:image/svg+xml;base64,${Buffer.from(xml).toString("base64")}`, alt, w, h };
}

/** Turns the article's inline SVG diagrams into pictures in place. Returns how many were kept. */
export async function keepSvgDiagrams(doc: Document, base: string, ua: string): Promise<number> {
  const diagrams = Array.from(doc.querySelectorAll("svg")).filter(isDiagram);
  if (!diagrams.length) return 0;
  const styles = new Styles(await pageCss(doc, base, ua));

  // A figure may hold one drawing in several versions (wide and narrow): keep what a desktop shows.
  const groups = new Map<El, El[]>();
  for (const svg of diagrams) {
    const home = svg.closest("figure") ?? svg;
    groups.set(home, [...(groups.get(home) ?? []), svg]);
  }

  let kept = 0;
  let budget = MAX_ARTICLE_SVG_BYTES;
  for (const [home, svgs] of groups) {
    const fig = home === svgs[0] ? null : home;
    let show = svgs.filter((s) => !hiddenOnDesktop(s, styles, fig));
    if (!show.length) show = [svgs.reduce((a, b) => (sizeOf(b).w > sizeOf(a).w ? b : a))];
    const caption = fig?.querySelector("figcaption")?.textContent?.replace(/\s+/g, " ").trim();
    const figures: El[] = [];
    for (const svg of show) {
      const pic = toPicture(svg, styles, doc);
      if (!pic || pic.src.length > budget) continue;
      budget -= pic.src.length;
      const f = doc.createElement("figure");
      const img = doc.createElement("img");
      img.setAttribute("src", pic.src);
      img.setAttribute("width", String(Math.round(pic.w)));
      img.setAttribute("height", String(Math.round(pic.h)));
      if (pic.alt) img.setAttribute("alt", pic.alt);
      f.appendChild(img);
      figures.push(f);
    }
    if (!figures.length) continue;
    if (caption && caption.length <= 600) {
      const fc = doc.createElement("figcaption");
      fc.textContent = caption;
      figures[figures.length - 1].appendChild(fc);
    }
    kept += figures.length;
    // A figure that also holds a photo keeps it: only the drawings are replaced.
    if (fig && !fig.querySelector("img")) fig.replaceWith(...figures);
    else {
      for (const svg of svgs.slice(1)) svg.remove();
      svgs[0].replaceWith(...figures);
    }
  }
  return kept;
}
