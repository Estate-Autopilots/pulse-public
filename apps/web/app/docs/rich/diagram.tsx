"use client";
// DOCS-RICH: a diagram block. Mermaid (MIT) draws flowcharts, timelines, gantt charts and mind maps from a few lines of
// text; it loads only when a doc has a diagram. Strict security level (no clicks, no HTML in labels, its own sanitiser),
// and the drawing is sanitised again (DOMPurify, SVG only) before it goes into the page. Light or dark follows Pulse.
import { useEffect, useId, useState } from "react";
import { DIAGRAM_STARTERS, diagramType } from "../../lib/doc-rich.mjs";
import r from "./rich.module.css";

export type DiagramBlock = { kind: "diagram"; id: string; title?: string; code?: string };
const dark = () => typeof document !== "undefined" && (document.documentElement.dataset.theme === "dark"
  || (!document.documentElement.dataset.theme && window.matchMedia?.("(prefers-color-scheme: dark)").matches));
let queue: Promise<unknown> = Promise.resolve();

/** The theme Pulse shows now, followed when it changes. */
function useDark() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () => setOn(dark());
    read();
    const mo = new MutationObserver(read); mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return on;
}

/** Mermaid code, drawn (one drawing at a time: Mermaid keeps global state while it draws). */
export function DiagramView({ code, title }: { code: string; title?: string }) {
  const id = `dg${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const isDark = useDark();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!code.trim()) return;
    const t = setTimeout(() => {
      queue = queue.then(async () => {
        const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([import("mermaid"), import("dompurify")]);
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark ? "dark" : "neutral", fontFamily: "inherit",
          themeVariables: { primaryColor: isDark ? "#2a2440" : "#efeafe", primaryBorderColor: isDark ? "#9085e9" : "#5b45d6", lineColor: isDark ? "#a7a8bb" : "#66687e" } });
        try {
          const out = await mermaid.render(`${id}-${Date.now()}`, code);
          if (live) { setSvg(DOMPurify.sanitize(out.svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["foreignObject"], FORBID_TAGS: ["script", "a"] })); setError(null); }
        } catch (e) {
          if (live) setError(e instanceof Error ? e.message.split("\n").slice(0, 3).join(" ") : "This diagram has a mistake.");
          document.getElementById(`d${id}`)?.remove();
        }
      }).catch(() => { if (live) setError("Diagrams could not load. Reload the page."); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [code, id, isDark]);
  const empty = !code.trim(), shown = empty ? null : svg, problem = empty ? null : error;
  return <figure className={r.diagram}>
    {title ? <figcaption className={r.chartHead}><span className={r.chartTitle}>{title}</span><small className={r.hint}>{diagramType(code)}</small></figcaption> : null}
    {problem ? <p className={r.error} role="alert">The diagram has a mistake: {problem}</p> : null}
    {shown ? <div className={r.diagramSvg} role="img" aria-label={`${title || diagramType(code)}: ${code.slice(0, 300)}`} dangerouslySetInnerHTML={{ __html: shown }} />
      : !problem ? <p className={r.hint}>{empty ? "Write the diagram below, or start from an example." : "Drawing…"}</p> : null}
  </figure>;
}

export function DiagramEditor({ block, onChange }: { block: DiagramBlock; onChange: (b: DiagramBlock) => void }) {
  const set = (part: Partial<DiagramBlock>) => onChange({ ...block, ...part });
  return <div className={r.form}>
    <label className={r.field}>Title<input value={block.title ?? ""} maxLength={120} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Launch plan" /></label>
    <div className={r.chips} aria-label="Start from an example">{(Object.keys(DIAGRAM_STARTERS) as (keyof typeof DIAGRAM_STARTERS)[]).map((k) =>
      <button key={k} type="button" className={r.chip} aria-pressed={diagramType(block.code ?? "") === diagramType(DIAGRAM_STARTERS[k])} onClick={() => set({ code: DIAGRAM_STARTERS[k] })}>
        {diagramType(DIAGRAM_STARTERS[k])}</button>)}</div>
    <label className={r.field}>The diagram, in Mermaid words (one step per line)
      <textarea className={r.code} rows={8} value={block.code ?? ""} maxLength={20000} spellCheck={false} onChange={(e) => set({ code: e.target.value })} /></label>
    <p className={r.hint}>Picking an example replaces the words above. The rules: mermaid.js.org/intro</p>
    <DiagramView code={block.code ?? ""} />
  </div>;
}
