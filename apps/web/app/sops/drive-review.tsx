"use client";
import { useState } from "react";
import { FlowCanvas } from "./flow";
import { SourceCard } from "./drive-parts";
import { StepsDoc } from "./view";
import type { Holder, Source } from "./types";
import css from "./sops.module.css";

/** The chosen part drawn as a flow (or as steps), the decision card, and the text it was read from. */
export function DriveReview({ source, people }: { source: Source; people: Record<string, Holder[]> }) {
  const [part, setPart] = useState(0), [view, setView] = useState<"flow" | "steps">("flow"), [sel, setSel] = useState<string | null>(null);
  const p = source.parts[part];
  return <div className={css.area}>
    {source.parts.length > 1 ? <nav className={css.sections} aria-label="SOPs in this document">{source.parts.map((x, i) =>
      <button key={i} type="button" className={css.section} aria-current={i === part ? "page" : undefined} onClick={() => { setPart(i); setSel(null); }}>{x.title}</button>)}</nav> : null}
    <div className={css.review}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        {p?.doc ? <><span className={css.toggle} role="group" aria-label="View" style={{ alignSelf: "flex-start" }}><button type="button" aria-pressed={view === "flow"} onClick={() => setView("flow")}>Flow</button><button type="button" aria-pressed={view === "steps"} onClick={() => setView("steps")}>Steps</button></span>
          {view === "flow" ? <FlowCanvas steps={p.doc.steps} people={people} selected={sel} onSelect={setSel} height={560} label={`${p.title}: as Pulse read it`} /> : <StepsDoc doc={p.doc} people={people} persons={{}} />}</> : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <ul className={css.sources}><SourceCard s={{ ...source, parts: p ? [p] : [] }} detail /></ul>
        {source.excerpt ? <details className={css.box} open={false}><summary className={css.sub} style={{ cursor: "pointer" }}>The text Pulse read</summary><pre className={css.excerpt}>{source.excerpt}{source.excerpt.length >= 6000 ? "\n…" : ""}</pre></details> : null}
      </div>
    </div>
  </div>;
}
