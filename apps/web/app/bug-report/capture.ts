// BUG-REPORT (owner, 27 Oct 2026; copied from Sales X-Ray's reporter, dev #2 26 Oct 2026): a picture of the screen
// for a bug report, made on the device. The visible part of the page is copied with its computed styles into an SVG
// foreignObject, drawn on a canvas and saved as WebP (JPEG where WebP cannot be written). Inner panels keep their scroll
// and every open layer (side panels, sheets, dialogs, menus) is drawn over the page behind it.
// Privacy (Pulse): nothing typed is drawn: every field's value becomes dots (passwords six), anything marked
// data-private or data-redact is a grey box, and tokens, keys and long opaque strings in the text read as markers.
// Left out: the reporter itself, anything marked data-capture-skip, video, frames and pictures from other sites.
// Nothing leaves the device here; the person sees the picture, can blur more, or leave it out, before sending.
// Fails quietly: any problem, or more than ten seconds, gives null.
import { hiddenValue, maskSecrets } from "../lib/bug-report.mjs";

const SKIP =
  "[data-capture-skip], script, noscript, template, iframe, video, audio, object, embed, link, meta, style";
/** Marks the reporter's own sheet, which its picture leaves out. */
export const REPORTER_MARK = "data-bug-reporter";
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_NODES = 8000;
const MAX_EDGE = 1600;
const MAX_INLINE_BYTES = 3 * 1024 * 1024;
const TIME_LIMIT_MS = 10000;
// A picture has nothing to scroll: no scroll bars over its panels.
const NO_SCROLLBARS =
  "*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}";

type Run = {
  budget: number;
  width: number;
  height: number;
  defaults: Map<string, Map<string, string>>;
  sandbox: Document;
  pseudo: string[];
  images: Array<[HTMLImageElement, HTMLImageElement]>;
  serial: number;
  /** Open top-layer copies (modal dialogs, popovers), drawn last over the page. */
  layers: Element[];
};

/** A modal dialog or an open popover: the browser draws it over everything. */
function onTopLayer(element: Element): boolean {
  for (const selector of [":modal", ":popover-open"]) {
    try {
      if (element.matches(selector)) return true;
    } catch {
      // An older browser without that layer.
    }
  }
  return false;
}

/** A modal's dimmed backdrop, when it has one. */
function backdropOf(element: Element): HTMLElement | null {
  let style: CSSStyleDeclaration;
  try {
    style = getComputedStyle(element, "::backdrop");
  } catch {
    return null;
  }
  const color = style.getPropertyValue("background-color");
  const image = style.getPropertyValue("background-image");
  const clear =
    !color || color === "transparent" || color === "rgba(0, 0, 0, 0)";
  if (clear && (!image || image === "none")) return null;
  const backdrop = document.createElement("div");
  backdrop.setAttribute(
    "style",
    `position:fixed;inset:0;background-color:${color || "transparent"};background-image:${image || "none"}`,
  );
  return backdrop;
}

function defaultsFor(run: Run, element: Element): Map<string, string> {
  const svg = element.namespaceURI === SVG_NS;
  const key = `${svg ? "svg:" : ""}${element.localName}`;
  const known = run.defaults.get(key);
  if (known) return known;
  const probe = svg
    ? run.sandbox.createElementNS(SVG_NS, element.localName)
    : run.sandbox.createElement(element.localName);
  const host = svg
    ? run.sandbox.body.appendChild(run.sandbox.createElementNS(SVG_NS, "svg"))
    : run.sandbox.body;
  host.appendChild(probe);
  const style = run.sandbox.defaultView!.getComputedStyle(probe);
  const values = new Map<string, string>();
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    values.set(name, style.getPropertyValue(name));
  }
  probe.remove();
  if (svg) host.remove();
  run.defaults.set(key, values);
  return values;
}

/** Only the properties that differ from the element's plain default. */
function styleText(
  style: CSSStyleDeclaration,
  defaults: Map<string, string>,
): string {
  const parts: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    const value = style.getPropertyValue(name);
    if (defaults.get(name) !== value) parts.push(`${name}:${value}`);
  }
  return parts.join(";");
}

function outside(run: Run, element: Element): boolean {
  const box = element.getBoundingClientRect();
  return (
    box.bottom < 0 ||
    box.right < 0 ||
    box.top > run.height ||
    box.left > run.width
  );
}

function copyPseudo(run: Run, element: Element, out: Element) {
  for (const which of ["::before", "::after"] as const) {
    const style = getComputedStyle(element, which);
    const content = style.getPropertyValue("content");
    if (!content || content === "none" || content === "normal") continue;
    const name = `pbcap${(run.serial += 1)}`;
    out.classList.add(name);
    const parts: string[] = [];
    for (let index = 0; index < style.length; index += 1) {
      const property = style.item(index);
      parts.push(`${property}:${style.getPropertyValue(property)}`);
    }
    run.pseudo.push(`.${name}${which}{${parts.join(";")}}`);
  }
}

/** Lets the page breathe every so often, so typing in the sheet never stalls. */
function breathe(run: Run): Promise<void> | null {
  return run.budget % 120 === 0
    ? new Promise((resolve) => window.setTimeout(resolve, 0))
    : null;
}

async function copyNode(run: Run, node: Node): Promise<Node | null> {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(maskSecrets(node.textContent ?? ""));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  if (element.matches(SKIP) || run.budget <= 0) return null;
  // The reporter's own sheet is not part of the screen it reports.
  if (element.matches(`[${REPORTER_MARK}]`) || ((element.localName === "dialog" || element.parentElement === document.body) && element.querySelector(`[${REPORTER_MARK}]`)))
    return null;
  // Private on purpose: a grey box the size of the original.
  if (element.matches("[data-private], [data-redact]")) {
    const box = element.getBoundingClientRect();
    const out = document.createElement("div");
    out.setAttribute("style", `display:${getComputedStyle(element).display === "inline" ? "inline-block" : "block"};width:${box.width}px;height:${box.height}px;background:#9aa0a6;border-radius:6px`);
    return out;
  }
  run.budget -= 1;
  await breathe(run);
  const style = getComputedStyle(element);
  if (style.display === "none") return null;

  let out: Element;
  if (element instanceof HTMLCanvasElement) {
    out = document.createElement("img");
    try {
      out.setAttribute("src", element.toDataURL());
    } catch {
      // A canvas holding another site's pixels stays a blank box.
    }
  } else {
    out = element.cloneNode(false) as Element;
  }
  for (const attribute of Array.from(out.attributes)) {
    if (
      attribute.name.startsWith("on") ||
      attribute.name === "srcset" ||
      attribute.name === "sizes" ||
      attribute.name === "loading"
    ) {
      out.removeAttribute(attribute.name);
    }
  }
  const text = styleText(style, defaultsFor(run, element));
  if (text) out.setAttribute("style", text);

  if (element instanceof HTMLImageElement && out instanceof HTMLImageElement) {
    out.removeAttribute("src");
    run.images.push([element, out]);
  } else if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") {
      if (element.checked) out.setAttribute("checked", "");
      else out.removeAttribute("checked");
    } else if (["button", "submit", "reset"].includes(element.type)) out.setAttribute("value", maskSecrets(element.value));
    // What was typed is never drawn (owner: "redact inputs and passwords").
    else out.setAttribute("value", hiddenValue(element.value, element.type === "password"));
  } else if (element instanceof HTMLTextAreaElement) {
    out.textContent = hiddenValue(element.value);
    return out;
  } else if (element instanceof HTMLSelectElement) {
    for (const option of Array.from(out.querySelectorAll("option"))) {
      option.removeAttribute("selected");
    }
  }

  // A box wholly off the screen keeps its size, not its insides.
  if (!(element instanceof SVGElement) && outside(run, element)) return out;
  if (element instanceof HTMLElement || element instanceof SVGSVGElement) {
    copyPseudo(run, element, out);
  }
  for (const child of Array.from(element.childNodes)) {
    const copied = await copyNode(run, child);
    if (copied) out.appendChild(copied);
  }
  if (element instanceof HTMLSelectElement) {
    const chosen = out.querySelectorAll("option")[element.selectedIndex];
    chosen?.setAttribute("selected", "");
  }
  // A modal or popover goes over the whole page, as the browser draws it.
  if (onTopLayer(element)) {
    const backdrop = backdropOf(element);
    if (backdrop) run.layers.push(backdrop);
    run.layers.push(out);
    return null;
  }
  // Inner panels keep their scroll: their children move up and left.
  const top = element.scrollTop;
  const left = element.scrollLeft;
  if (top || left) {
    for (const child of Array.from(out.children)) {
      if (!(child instanceof HTMLElement || child instanceof SVGElement))
        continue;
      const before = child.style.transform;
      child.style.transform = `translate(${-left}px, ${-top}px)${
        before && before !== "none" ? ` ${before}` : ""
      }`;
    }
  }
  return out;
}

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("unreadable"));
    reader.readAsDataURL(blob);
  });
}

/** Same-site pictures go inside the copy; others stay blank boxes. */
async function inlineImages(run: Run) {
  let total = 0;
  for (const [original, copy] of run.images.slice(0, 30)) {
    const source = original.currentSrc || original.src;
    if (!source) continue;
    if (source.startsWith("data:")) {
      copy.setAttribute("src", source);
      continue;
    }
    let url: URL;
    try {
      url = new URL(source, window.location.href);
    } catch {
      continue;
    }
    if (url.origin !== window.location.origin && url.protocol !== "blob:")
      continue;
    try {
      const blob = await (
        await fetch(url, { credentials: "same-origin" })
      ).blob();
      total += blob.size;
      if (total > MAX_INLINE_BYTES || !blob.type.startsWith("image/")) continue;
      copy.setAttribute("src", await asDataUrl(blob));
    } catch {
      // Left blank.
    }
  }
}

const FONT_TIME_MS = 2500;

function family(value: string): string {
  return value.replace(/["']/g, "").trim().toLowerCase();
}

function range(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/**
 * The page's own fonts (same site) that it has actually loaded, fetched
 * together, so the picture's text looks like the screen. If they take longer
 * than 2.5 seconds the picture uses the device's fonts instead.
 */
async function fontRules(): Promise<string> {
  const loaded = new Set(
    Array.from(document.fonts ?? [])
      .filter((face) => face.status === "loaded")
      .map((face) => `${family(face.family)}|${range(face.unicodeRange)}`),
  );
  const wanted: Array<{ text: string; urls: Array<[string, URL]> }> = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue; // another site's sheet
    }
    for (const rule of Array.from(list)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const key = `${family(rule.style.getPropertyValue("font-family"))}|${range(
        rule.style.getPropertyValue("unicode-range") || "U+0-10FFFF",
      )}`;
      if (!loaded.has(key)) continue;
      const urls: Array<[string, URL]> = [];
      for (const [whole, raw] of rule.cssText.matchAll(
        /url\(["']?([^"')]+)["']?\)/g,
      )) {
        try {
          urls.push([whole, new URL(raw, sheet.href ?? window.location.href)]);
        } catch {
          // Left out.
        }
      }
      if (urls.every(([, url]) => url.origin === window.location.origin)) {
        wanted.push({ text: rule.cssText, urls });
      }
    }
  }
  const embed = Promise.all(
    wanted.map(async ({ text, urls }) => {
      let rule = text;
      for (const [whole, url] of urls) {
        const blob = await (await fetch(url)).blob();
        rule = rule.replace(whole, `url("${await asDataUrl(blob)}")`);
      }
      return rule;
    }),
  ).then((rules) => {
    const css = rules.join("");
    return css.length > MAX_INLINE_BYTES * 1.4 ? "" : css;
  });
  return Promise.race([
    embed.catch(() => ""),
    new Promise<string>((resolve) =>
      window.setTimeout(() => resolve(""), FONT_TIME_MS),
    ),
  ]);
}

function escapeStyle(text: string): string {
  return text.replace(/</g, "\\3c ").replace(/]]>/g, "]] >");
}

function drawn(
  svg: string,
  width: number,
  height: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      const scale = Math.min(
        window.devicePixelRatio || 1,
        MAX_EDGE / Math.max(width, height),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) return resolve(null);
      context.scale(scale, scale);
      try {
        context.drawImage(image, 0, 0, width, height);
        canvas.toBlob(
          (webp) => {
            if (webp?.type === "image/webp") return resolve(webp);
            canvas.toBlob((jpeg) => resolve(jpeg), "image/jpeg", 0.85);
          },
          "image/webp",
          0.82,
        );
      } catch {
        resolve(null); // a tainted canvas
      }
    };
    image.onerror = () => resolve(null);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * The copy of the screen the picture is drawn from: the page, then each open
 * layer over it (exported for tests).
 */
export async function copyScreen(): Promise<HTMLElement | null> {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("data-capture-skip", "");
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:10px;height:10px;border:0;visibility:hidden";
  document.body.appendChild(frame);
  try {
    const sandbox = frame.contentDocument;
    if (!sandbox?.body) return null;
    const run: Run = {
      budget: MAX_NODES,
      width,
      height,
      defaults: new Map(),
      sandbox,
      pseudo: [],
      images: [],
      serial: 0,
      layers: [],
    };
    const page = document.createElement("div");
    page.setAttribute(
      "style",
      `${styleText(getComputedStyle(document.documentElement), defaultsFor(run, document.documentElement))};width:${width}px;height:${height}px;overflow:hidden;margin:0`,
    );
    const body = document.createElement("div");
    body.setAttribute(
      "style",
      `${styleText(getComputedStyle(document.body), defaultsFor(run, document.body))};margin:0;transform:translate(${-window.scrollX}px, ${-window.scrollY}px)`,
    );
    for (const child of Array.from(document.body.childNodes)) {
      const copied = await copyNode(run, child);
      if (copied) body.appendChild(copied);
    }
    page.appendChild(body);
    // Open layers over the page, in order; outside the scrolled body, as the
    // browser places them against the window.
    run.layers.forEach((layer, index) => {
      const element = layer as HTMLElement;
      element.style.zIndex = String(2147483000 + index);
      page.appendChild(element);
    });
    await inlineImages(run);
    page.dataset.pseudo = run.pseudo.join("");
    return page;
  } finally {
    frame.remove();
  }
}

async function capture(): Promise<Blob | null> {
  const page = await copyScreen();
  if (!page) return null;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pseudo = page.dataset.pseudo ?? "";
  delete page.dataset.pseudo;
  const fonts = await fontRules().catch(() => "");
  const markup = new XMLSerializer().serializeToString(page);
  const svg =
    `<svg xmlns="${SVG_NS}" width="${width}" height="${height}">` +
    `<style>${escapeStyle(fonts + NO_SCROLLBARS + pseudo)}</style>` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
  return drawn(svg, width, height);
}

/** A picture of what is on the screen now, or null. */
export function captureScreen(): Promise<Blob | null> {
  if (typeof window === "undefined" || typeof XMLSerializer === "undefined") {
    return Promise.resolve(null);
  }
  return Promise.race([
    capture().catch(() => null),
    new Promise<null>((resolve) =>
      window.setTimeout(() => resolve(null), TIME_LIMIT_MS),
    ),
  ]);
}
