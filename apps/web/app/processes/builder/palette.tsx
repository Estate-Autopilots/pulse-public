"use client";
// FLOW-D (owner, 21 Oct 2026: "can there not be blocks that are just the primitives of all?"): the palette is the dozen
// primitives any company's work is made of (Start, Task, Collect, Meet, Write, Review, Decide, Wait, Message, AI, App
// action, Repeat, End), each with its plain question, and below them the company's own blocks (saved, named presets of
// a primitive). Drag one onto the canvas, or press it to add it after the chosen step. Nothing here names an industry.
import { useMemo, useState, type RefObject } from "react";
import { PanelLeftClose, Plus, Search } from "lucide-react";
import type { CompanyBlock, Primitive } from "../flow-types";
import { ModuleIcon } from "./kinds";
import css from "./builder.module.css";

/** What a palette item adds: "block:<primitive>" or "preset:<company block id>". */
export const pickBlock = (key: string) => `block:${key}`;
export const pickPreset = (id: string) => `preset:${id}`;

export function Palette({ primitives, blocks, onAdd, search, readOnly, open, onOpen }: { primitives: Primitive[]; blocks: CompanyBlock[]; onAdd: (pick: string) => void;
  search: RefObject<HTMLInputElement | null>; readOnly: boolean; open: boolean; onOpen: (open: boolean) => void }) {
  const [q, setQ] = useState("");
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const has = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const prims = primitives.filter((p) => has(`${p.name} ${p.question} ${p.summary} ${p.kinds.map((k) => k.label).join(" ")}`));
  const name = useMemo(() => Object.fromEntries(primitives.map((p) => [p.key, p])), [primitives]);
  const own = blocks.filter((b) => has(`${b.name} ${b.summary ?? ""} ${name[b.block]?.name ?? ""}`));
  const drag = (e: React.DragEvent, pick: string) => { e.dataTransfer.setData("application/x-pulse-module", pick); e.dataTransfer.effectAllowed = "copy"; };
  if (!open) return <aside className={css.palette} data-closed="" data-float-avoid="" aria-label="Steps you can add">
    <button type="button" className={css.palOpen} onClick={() => { onOpen(true); requestAnimationFrame(() => search.current?.focus()); }} aria-label="Add a step" title="Add a step (/)"><Plus size={18} /></button>
  </aside>;
  return <aside className={css.palette} data-float-avoid="" aria-label="Steps you can add">
    <div className={css.palHead}><b>Add a step</b><button type="button" className={css.close} onClick={() => onOpen(false)} aria-label="Fold the list of steps away" title="Fold away"><PanelLeftClose size={15} /></button></div>
    <label className={css.palSearch}><Search size={14} aria-hidden="true" /><input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a step or a block" aria-label="Find a step to add" /><kbd>/</kbd></label>
    <div className={css.palList}>
      {prims.length ? <section aria-label="Steps">
        <ul className={css.primGrid}>{prims.map((p) => <li key={p.key}>
          <button type="button" className={css.primItem} draggable={!readOnly} disabled={readOnly} data-block={p.key} onDragStart={(e) => drag(e, pickBlock(p.key))} onClick={() => onAdd(pickBlock(p.key))} title={`${p.summary}`}>
            <span className={css.primIcon}><ModuleIcon name={p.icon} size={16} /></span><b>{p.name}</b><small>{p.question}</small>
          </button></li>)}</ul>
      </section> : null}
      <section aria-label="Your company's blocks">
        <h4>Your company’s blocks</h4>
        {own.length ? <ul>{own.map((b) => <li key={b.id}>
          <button type="button" className={css.palItem} draggable={!readOnly} disabled={readOnly} onDragStart={(e) => drag(e, pickPreset(b.id))} onClick={() => onAdd(pickPreset(b.id))} title={b.summary ?? b.name}>
            <span className={css.palIcon} data-block={b.block}><ModuleIcon name={name[b.block]?.icon} size={15} /></span>
            <span className={css.palText}><b>{b.name}</b><small>{name[b.block]?.name ?? b.block}{b.summary ? ` · ${b.summary}` : ""}</small></span>
          </button></li>)}</ul>
          : <p className={css.palNone}>{q ? `No block matches “${q}”.` : "None yet. Choose a step and press “Save as a block” to reuse it here."}</p>}
      </section>
      {!prims.length && !own.length ? <p className={css.palNone}>Nothing matches “{q}”.</p> : null}
    </div>
  </aside>;
}
