"use client";
// DOCS-RICH: big numbers. One to six figures in a row (two per row on a phone), each with what it is and, if you like,
// its change ("+12% vs Sep"). The change is coloured by whether it is good, and always carries an arrow and its sign
// (never colour alone).
import { Plus, X } from "lucide-react";
import r from "./rich.module.css";

export type StatItem = { value: string; label?: string; delta?: string; tone?: "good" | "bad" | "neutral" };
export type StatBlock = { kind: "stat"; id: string; title?: string; items?: StatItem[] };

export function StatView({ block }: { block: StatBlock }) {
  const items = (block.items ?? []).filter((x) => x.value);
  if (!items.length) return <p className={r.hint}>Add a number.</p>;
  return <section className={r.stats} aria-label={block.title || "Key numbers"}>
    {block.title ? <p className={r.statsTitle}>{block.title}</p> : null}
    <div className={r.statRow} data-count={items.length}>{items.map((x, i) => <div key={i} className={r.stat}>
      <span className={r.statValue}>{x.value}</span>
      {x.label ? <span className={r.statLabel}>{x.label}</span> : null}
      {x.delta ? <span className={r.delta} data-tone={x.tone === "good" ? "up" : x.tone === "bad" ? "down" : "flat"}>
        {x.tone === "good" ? "▲ " : x.tone === "bad" ? "▼ " : ""}{x.delta}<span className={r.srOnly}>{x.tone === "good" ? " (good)" : x.tone === "bad" ? " (bad)" : ""}</span></span> : null}
    </div>)}</div>
  </section>;
}

export function StatEditor({ block, onChange }: { block: StatBlock; onChange: (b: StatBlock) => void }) {
  const items = block.items ?? [];
  const set = (i: number, part: Partial<StatItem>) => onChange({ ...block, items: items.map((x, k) => k === i ? { ...x, ...part } : x) });
  return <div className={r.form}>
    <label className={r.field}>Title (optional)<input value={block.title ?? ""} maxLength={120} onChange={(e) => onChange({ ...block, title: e.target.value })} /></label>
    {items.map((x, i) => <fieldset key={i} className={r.statEdit}>
      <legend className={r.srOnly}>Number {i + 1}</legend>
      <label className={r.field}>Number<input value={x.value} maxLength={24} onChange={(e) => set(i, { value: e.target.value })} placeholder="₹42.6 L" /></label>
      <label className={r.field}>What it is<input value={x.label ?? ""} maxLength={60} onChange={(e) => set(i, { label: e.target.value })} placeholder="Revenue" /></label>
      <label className={r.field}>Change (optional)<input value={x.delta ?? ""} maxLength={40} onChange={(e) => set(i, { delta: e.target.value })} placeholder="+12% vs Sep" /></label>
      <label className={r.field}>The change is<select value={x.tone ?? "neutral"} onChange={(e) => set(i, { tone: e.target.value as StatItem["tone"] })}>
        <option value="good">Good</option><option value="bad">Bad</option><option value="neutral">Neither</option></select></label>
      <button type="button" className={r.iconBtn} aria-label={`Remove number ${i + 1}`} onClick={() => onChange({ ...block, items: items.filter((_, k) => k !== i) })}><X size={15} aria-hidden="true" /></button>
    </fieldset>)}
    <button type="button" className={r.btn} disabled={items.length >= 6} onClick={() => onChange({ ...block, items: [...items, { value: "", label: "", delta: "", tone: "neutral" }] })}>
      <Plus size={15} aria-hidden="true" />Add a number</button>
  </div>;
}
