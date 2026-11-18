// DOCS-RICH: export keeps the rich blocks. PDF: each block is printed as it looks on screen (charts and diagrams as SVG
// with their colours written in, big numbers and tables as HTML; a web page prints as a note that it lives in the doc).
// Markdown: each chart and diagram gains an SVG picture (a data: image) just above its ```pulse-block fence, and a diagram
// also a ```mermaid fence (which GitHub and most Markdown viewers draw); the fence stays so the file imports back.
import { blocksOf } from "../../lib/doc-rich.mjs";
import { isNumberCell, isTotalRow } from "../../lib/doc-read.mjs";

// DOCS-POLISH: line height, wrapping and alignment too, for a diagram's words (HTML inside the SVG's foreignObject): the
// print page's own line height made them taller than their boxes.
const STYLE_PROPS = ["fill", "stroke", "stroke-width", "stroke-opacity", "fill-opacity", "opacity", "font-size", "font-weight", "font-family", "stroke-dasharray", "stroke-linecap", "stroke-linejoin",
  "line-height", "white-space", "text-align"];
/** An SVG drawn on screen as a standalone SVG: its computed colours and fonts written on each element. */
export function standaloneSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement, src = svg.querySelectorAll("*"), dst = clone.querySelectorAll("*");
  src.forEach((el, i) => { const cs = getComputedStyle(el), d = dst[i] as SVGElement; for (const p of STYLE_PROPS) d.style.setProperty(p, cs.getPropertyValue(p)); });
  const box = svg.getBoundingClientRect();
  const w = Math.round(box.width || Number(svg.getAttribute("width")) || 600), h = Math.round(box.height || Number(svg.getAttribute("height")) || 300);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg"); clone.setAttribute("width", String(w)); clone.setAttribute("height", String(h));
  // DOCS-POLISH: a little room on both sides, so a label that spills past the chart's edge on screen is not cut on paper
  if (!clone.getAttribute("viewBox")) { clone.setAttribute("viewBox", `-16 0 ${w + 32} ${h}`); clone.setAttribute("width", String(w + 32)); }
  clone.querySelectorAll("[tabindex]").forEach((el) => el.removeAttribute("tabindex"));
  return new XMLSerializer().serializeToString(clone);
}
const blockEl = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One block as printable HTML, from how it is drawn in the open doc. */
function printable(el: HTMLElement | null, b: Record<string, unknown>): string {
  if (b.kind === "html") return `<div class="pulse-print-note">Web page “${esc(String(b.title ?? "Web page"))}”: open the doc in Vitals to use it.</div>`;
  if (!el) return "";
  const card = (el.querySelector("[data-print]") ?? el) as HTMLElement;
  const clone = card.cloneNode(true) as HTMLElement;
  const live = card.querySelectorAll("svg"), copies = clone.querySelectorAll("svg");
  live.forEach((svg, i) => { const holder = document.createElement("div"); holder.innerHTML = standaloneSvg(svg as SVGSVGElement); copies[i]?.replaceWith(holder.firstElementChild ?? holder); });
  // a legend's swatches and a change's colour come from classes the print window does not have: write them in
  const liveI = card.querySelectorAll("i, [data-tone]"), copyI = clone.querySelectorAll("i, [data-tone]");
  liveI.forEach((el, i) => { const cs = getComputedStyle(el), d = copyI[i] as HTMLElement | undefined; if (!d) return;
    if (el.tagName === "I") d.setAttribute("style", `display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;background:${cs.backgroundColor}`);
    else d.style.color = cs.color; });
  clone.querySelectorAll("button, input, select, textarea, [role=status], dialog, iframe, [data-no-print]").forEach((x) => x.remove());
  return `<div class="pulse-print-block">${clone.innerHTML}</div>`;
}
/** The doc's HTML with each block replaced by how it looks (for the PDF). */
export function printableHtml(html: string, root: ParentNode): string {
  const byId = new Map(blocksOf(html).map((b) => [String(b.id), b]));
  return html.replace(/<div\b[^>]*data-type="pulse-block"[^>]*>\s*<\/div>/g, (tag) => {
    const id = (tag.match(/data-id="([^"]*)"/) ?? [])[1] ?? "", b = byId.get(id);
    return b ? printable(blockEl(root, id), b) : tag;
  });
}
const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
/** Markdown with a picture of each chart and diagram above its fence (and the diagram's Mermaid code). */
export function markdownWithPictures(md: string, root: ParentNode): string {
  return md.replace(/```pulse-block[ \t]*\n([\s\S]*?)\n```/g, (fence, json: string) => {
    let b: Record<string, unknown>;
    try { b = JSON.parse(json); } catch { return fence; }
    const svg = b.kind === "chart" || b.kind === "diagram" ? blockEl(root, String(b.id ?? ""))?.querySelector("svg") : null;
    const pic = svg ? `![${String(b.title || (b.kind === "chart" ? "Chart" : "Diagram")).replace(/[[\]]/g, "")}](data:image/svg+xml;base64,${b64(standaloneSvg(svg as SVGSVGElement))})\n\n` : "";
    const mermaid = b.kind === "diagram" && typeof b.code === "string" && b.code.trim() ? `\`\`\`mermaid\n${b.code}\n\`\`\`\n\n` : "";
    return `${pic}${mermaid}${fence}`;
  });
}

// DOCS-POLISH: the PDF reads like the page. Number columns right-aligned, a Total row bold, a picture's caption under it.
/** The doc's HTML for print: each table's number columns and total rows marked, pictures with a title as captioned figures. */
export function readingHtml(html: string, title = ""): string {
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, "text/html");
  const root = doc.getElementById("r");
  if (!root) return html;
  // the cover already says the title: a first heading that only repeats it is left out (as on screen for readers)
  const first = root.firstElementChild, same = (a: string) => a.replace(/\s+/g, " ").trim().toLowerCase();
  if (first && /^H[1-4]$/.test(first.tagName) && title.trim() && same(first.textContent ?? "") === same(title)) first.remove();
  root.querySelectorAll("table").forEach((t) => {
    const rows = [...t.querySelectorAll("tr")];
    const body = rows.filter((r) => r.querySelector("td"));
    const width = Math.max(0, ...rows.map((r) => r.children.length));
    for (let j = 0; j < width; j++) {
      const filled = body.map((r) => (r.children[j]?.textContent ?? "").trim()).filter((x) => x && !/^[-–—]$/.test(x));
      if (filled.length && filled.filter(isNumberCell).length * 3 >= filled.length * 2) rows.forEach((r) => r.children[j]?.setAttribute("data-num", ""));
    }
    body.forEach((r) => { if (isTotalRow(r.children[0]?.textContent ?? "")) r.setAttribute("data-total", ""); });
  });
  root.querySelectorAll("img[title]").forEach((img) => {
    const cap = img.getAttribute("title")?.trim(); if (!cap) return;
    const fig = doc.createElement("figure"), fc = doc.createElement("figcaption");
    fc.textContent = cap; img.replaceWith(fig); fig.append(img, fc);
  });
  return root.innerHTML;
}
/** The print window's look: a calm reading page (A4, 2 cm margins), in print colours. */
export const PRINT_CSS = `@page{size:A4;margin:18mm 16mm}*{box-sizing:border-box}
body{font:11.5pt/1.65 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1e1b2e;max-width:720px;margin:0 auto;padding:24px 0}
.cover{padding:18px 22px;margin:0 0 22px;border-radius:14px;background:linear-gradient(120deg,#efeaff,#f7f5ff 60%,#fff);border:1px solid #e4defc}
.cover .chip{display:inline-block;padding:2px 10px;border-radius:999px;background:#e4dcff;color:#4b2fd0;font-size:9pt;font-weight:650}
.cover h1{font-size:24pt;line-height:1.15;margin:8px 0 6px;letter-spacing:-.01em}.cover p{margin:0;color:#6b6880;font-size:9.5pt}
h1{font-size:19pt;margin:22px 0 8px}h2{font-size:15pt;margin:20px 0 6px;break-after:avoid}h3{font-size:12.5pt;margin:16px 0 4px;break-after:avoid}
p{margin:6px 0}a{color:#4b2fd0}img{max-width:100%;border-radius:8px}figure{margin:12px 0;break-inside:avoid}figcaption{font-size:9pt;color:#6b6880;text-align:center;margin-top:4px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:10pt;font-variant-numeric:tabular-nums;break-inside:auto}
th,td{border:0;border-bottom:1px solid #e6e3ef;padding:6px 10px;text-align:left;vertical-align:top}th p,td p{margin:0}
tr:first-child th{background:#f3f1fa;font-weight:650;border-bottom:1.5px solid #d9d4ea}tbody tr:nth-child(even) td{background:#faf9fd}
[data-num]{text-align:right}tr[data-total] td{font-weight:700;border-top:1.5px solid #bdb6d6;background:#f3f1fa}
blockquote{margin:12px 0;padding:4px 0 4px 16px;border-left:3px solid #6b4cf0;color:#3d3a52;font-size:12.5pt}
pre{background:#f5f4fa;border:1px solid #e6e3ef;padding:10px 12px;border-radius:8px;white-space:pre-wrap;font-size:9.5pt}code{font-family:ui-monospace,Menlo,Consolas,monospace}
div[data-type=callout]{border-radius:10px;padding:8px 14px;margin:12px 0;background:#f2efff;border-left:4px solid #6b4cf0;break-inside:avoid}
div[data-type=callout][data-tone=tip]{background:#ecf8f0;border-left-color:#16a34a}div[data-type=callout][data-tone=warning]{background:#fff6e6;border-left-color:#d97706}
div[data-type=callout][data-tone=danger]{background:#fdecef;border-left-color:#e11d48}ul[data-type=taskList]{list-style:none;padding-left:4px}
span[data-type=mention]{background:#efedf7;border-radius:999px;padding:0 6px}hr{border:0;border-top:1px solid #e6e3ef;margin:18px 0}
.pulse-print-block{margin:14px 0;padding:0 14px;break-inside:avoid}.pulse-print-block svg{display:block;margin:0 auto;max-width:100%;height:auto;overflow:visible}.pulse-print-note{border:1px dashed #999;border-radius:8px;padding:10px 12px;color:#444}
div[data-type=columns]{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}div[data-type=columns][data-count="3"]{grid-template-columns:repeat(3,1fr)}
details{border:1px solid #e6e3ef;border-radius:10px;padding:6px 14px;margin:12px 0}summary{font-weight:650}
.pulse-print-block section>div{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.pulse-print-block section>div>div{border:1px solid #e6e3ef;border-radius:12px;padding:10px 14px;display:flex;flex-direction:column}
.pulse-print-block section>div>div>span:first-child{font-size:20pt;font-weight:700}
.pulse-print-block ol{list-style:none;padding:0;margin:0}.pulse-print-block ol li{display:grid;grid-template-columns:16px 90px 1fr;gap:8px;padding:4px 0;border-bottom:1px dashed #e6e3ef}
.pulse-print-block ul{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:4px 14px;font-size:9pt}`;
