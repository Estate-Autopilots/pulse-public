"use client";
// FLOW-D (owner, 21 Oct 2026: "creating is hard"): the default view of a process is a vertical flow, like an automation
// list. Steps run top to bottom, grouped by stage; steps side by side run at the same time; after a Decide each way
// has its own steps. A big "+" between steps adds one (a primitive or one of the company's blocks); a step opens its
// side sheet. An empty process shows three steps to begin; a first-time hint says how to read it (and goes away).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CircleAlert, Columns2, Play, Plus, Search, Sparkles, X } from "lucide-react";
import { stepRuns, moduleOf } from "../../lib/flow-canvas.mjs";
import { rows, wayOf } from "../../lib/flow-list.mjs";
import type { CompanyBlock, FlowDef, FlowStep, ModuleManifest, Primitive, Problem } from "../flow-types";
import { NEEDS_WHO } from "./canvas";
import { ModuleIcon } from "./kinds";
import css from "./builder.module.css";

/** Where a new step goes. */
export type Where = { at: "after"; id: string; port?: string | null } | { at: "beside"; id: string } | { at: "row"; ids: string[] } | { at: "stage"; stage: string | null } | { at: "before"; id: string } | { at: "first" };

export function FlowList({ def, byKey, primitives, blocks, sel, onSelect, readOnly, problems, values, roleLabel, dueLabel, onAdd, onDescribe, onStage }: {
  def: FlowDef; byKey: Record<string, ModuleManifest>; primitives: Primitive[]; blocks: CompanyBlock[]; sel: string | null; onSelect: (id: string | null) => void; readOnly: boolean;
  problems: Problem[]; values: Record<string, string>; roleLabel: (s: FlowStep) => string | null; dueLabel: (s: FlowStep) => string | null;
  onAdd: (where: Where, pick: string) => void; onDescribe: () => void; onStage: (fn: (d: FlowDef) => FlowDef) => void;
}) {
  const groups = useMemo(() => rows(def, byKey), [def, byKey]);
  const [menu, setMenu] = useState<Where | null>(null);
  const hint = useStored("pulse.flow.listHint") === "";
  const seen = () => store("pulse.flow.listHint", "seen");
  const per = useMemo(() => { const m = new Map<string, Problem[]>(); for (const p of problems) if (p.step) m.set(p.step, [...(m.get(p.step) ?? []), p]); return m; }, [problems]);
  const anyVariant = Object.values(values).some(Boolean);
  const plus = (where: Where, label: string, big = false) => readOnly ? null
    : <button type="button" className={big ? css.plusBig : css.plusSmall} onClick={() => setMenu(where)} aria-label={label} title={label}><Plus size={big ? 18 : 14} aria-hidden="true" />{big ? null : <span>{label}</span>}</button>;

  if (!def.steps.length) return <div className={css.listWrap}><Empty readOnly={readOnly} onStart={() => onAdd({ at: "first" }, "block:start")} onDescribe={onDescribe} />
    {menu ? <AddMenu primitives={primitives} blocks={blocks} onPick={(p) => { onAdd(menu, p); setMenu(null); }} onClose={() => setMenu(null)} /> : null}</div>;

  let n = 0;
  return <div className={css.listWrap}>
    {hint ? <p className={css.listHint} role="note"><Sparkles size={14} aria-hidden="true" /><span>Steps run <b>top to bottom</b>. Steps <b>side by side</b> run at the same time. Press <b>+</b> to add a step; press a step to say who does it and when.</span>
      <button type="button" onClick={seen} aria-label="Got it, hide this hint"><X size={14} /></button></p> : null}
    <ol className={css.flowList} aria-label="The steps, in order">
      {groups.map((g) => <li key={g.key || "none"} className={css.stageGroup} aria-label={g.label}>
        {def.stages.length || g.key ? <StageHead group={g} def={def} readOnly={readOnly} onStage={onStage} /> : null}
        {g.rows.map((row, ri) => <div key={row.map((s) => s.id).join("|")} className={css.rowWrap}>
          <div className={css.row} data-many={row.length > 1 ? "" : undefined}>
            {row.map((s) => { n++; const m = moduleOf(s, byKey), way = wayOf(def, byKey, s.id), probs = per.get(s.id) ?? [];
              const off = anyVariant && !stepRuns(s, values), who = !s.block || NEEDS_WHO.has(s.block) || (s.block === "message" && s.module === "message") ? roleLabel(s) : null, due = dueLabel(s);
              const isDecide = s.block === "decide" || s.module === "decision";
              return <div key={s.id} className={css.cell}>
                {way ? <span className={css.way}>{way.label}</span> : null}
                <div className={css.lcardWrap}>
                  <button type="button" className={css.lcard} data-block={s.block ?? undefined} data-chosen={sel === s.id ? "" : undefined} data-off={off ? "" : undefined} aria-pressed={sel === s.id}
                    onClick={() => onSelect(sel === s.id ? null : s.id)}>
                    <span className={css.lnum} aria-hidden="true">{n}</span>
                    <span className={css.licon}><ModuleIcon name={m.icon} size={16} /></span>
                    <span className={css.ltext}><b>{s.title || m.kindLabel || m.name}</b>
                      <small>{[s.block ? m.name : m.name, who, due].filter(Boolean).join(" · ")}{off ? " · not for this one" : ""}</small></span>
                    {probs.length ? <em className={css.lwarn} data-level={probs.some((p) => p.level === "error") ? "error" : "warning"} title={probs.map((p) => p.text).join("\n")}><CircleAlert size={13} aria-hidden="true" />{probs.length}</em> : null}
                  </button>
                  {!readOnly && s.block !== "start" ? <button type="button" className={css.beside} onClick={() => setMenu({ at: "beside", id: s.id })} aria-label={`Add a step at the same time as ${s.title || m.name}`} title="Add a step at the same time"><Columns2 size={14} /></button> : null}
                </div>
                {isDecide ? <div className={css.ways}>{moduleOf(s, byKey).makes.map((p) => <span key={p.key}>{plus({ at: "after", id: s.id, port: p.key }, `If ${p.label}`)}</span>)}</div>
                  : row.length > 1 ? plus({ at: "after", id: s.id }, "Then") : null}
              </div>; })}
          </div>
          {ri < g.rows.length - 1 ? <div className={css.join}>{plus({ at: "row", ids: row.map((s) => s.id) }, "Add a step here", true)}</div> : null}
        </div>)}
        {!readOnly ? <div className={css.stageEnd}>{plus({ at: "stage", stage: g.key || null }, g.key ? `Add a step to ${g.label}` : "Add a step", true)}<span>{g.key ? `Add a step to ${g.label}` : "Add a step"}</span></div> : null}
      </li>)}
    </ol>
    {!readOnly ? <AddStage onAdd={(label) => onStage((d) => { const key = `st${d.stages.length + 1}_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20)}`;
      return { ...d, stages: [...d.stages, { key, label }] }; })} /> : null}
    {menu ? <AddMenu primitives={primitives} blocks={blocks} where={menu} onPick={(p) => { onAdd(menu, p); setMenu(null); }} onClose={() => setMenu(null)} /> : null}
  </div>;
}

function StageHead({ group, def, readOnly, onStage }: { group: { key: string; label: string; rows: FlowStep[][] }; def: FlowDef; readOnly: boolean; onStage: (fn: (d: FlowDef) => FlowDef) => void }) {
  const i = def.stages.findIndex((s) => s.key === group.key);
  const count = group.rows.reduce((n, r) => n + r.length, 0);
  return <div className={css.stageHead}>
    {/^(stage|phase|part)?\s*\d/i.test(group.label) ? null : <span className={css.stageNum}>{i >= 0 ? i + 1 : "·"}</span>}
    {group.key && !readOnly ? <input className={css.stageName} defaultValue={group.label} aria-label="Stage name" maxLength={120}
      onBlur={(e) => { const label = e.target.value.trim(); if (label && label !== group.label) onStage((d) => ({ ...d, stages: d.stages.map((s) => s.key === group.key ? { ...s, label } : s) })); }} />
      : <b className={css.stageName}>{group.label}</b>}
    <small>{count} {count === 1 ? "step" : "steps"}</small>
  </div>;
}

function AddStage({ onAdd }: { onAdd: (label: string) => void }) {
  const [open, setOpen] = useState(false), [name, setName] = useState("");
  if (!open) return <button type="button" className={css.addStage} onClick={() => setOpen(true)}><Plus size={14} aria-hidden="true" />Add a stage</button>;
  return <form className={css.addStageForm} onSubmit={(e) => { e.preventDefault(); if (name.trim()) onAdd(name.trim()); setName(""); setOpen(false); }}>
    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Install" autoFocus maxLength={120} aria-label="The new stage's name" />
    <button type="submit" className={css.saveBlock}>Add the stage</button><button type="button" className={css.link} onClick={() => setOpen(false)}>Cancel</button></form>;
}

/** An empty process: three steps to begin, one obvious first action. */
function Empty({ readOnly, onStart, onDescribe }: { readOnly: boolean; onStart: () => void; onDescribe: () => void }) {
  return <section className={css.empty} aria-labelledby="empty-title">
    <h2 id="empty-title">Three steps to a process</h2>
    <ol>
      <li><b>Say how it starts.</b><span>By hand on a client, when a lead comes in, when a form is sent, or on a schedule.</span></li>
      <li><b>Add the steps, one under another.</b><span>Press + and choose: a Task, Collect information, a Meeting, Write, Review, Decide, a Message …</span></li>
      <li><b>Try it, then go live.</b><span>Walk through it as each person with sample data; nothing reaches anyone until it is live.</span></li>
    </ol>
    {!readOnly ? <div className={css.emptyActions}>
      <button type="button" className={css.primaryBtn} onClick={onStart}><Play size={15} aria-hidden="true" />Add how it starts</button>
      <button type="button" className={css.saveBlock} onClick={onDescribe}><Sparkles size={14} aria-hidden="true" />Or describe it and let Pip draft it</button>
    </div> : null}
  </section>;
}

/** The "+" menu: the primitives first, then the company's own blocks. */
export function AddMenu({ primitives, blocks, onPick, onClose, where }: { primitives: Primitive[]; blocks: CompanyBlock[]; onPick: (pick: string) => void; onClose: () => void; where?: Where }) {
  const [q, setQ] = useState(""); const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }; document.addEventListener("keydown", key, true); return () => document.removeEventListener("keydown", key, true); }, [onClose]);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean), has = (t: string) => words.every((w) => t.toLowerCase().includes(w));
  const prims = primitives.filter((p) => p.key !== "start" || where?.at === "first").filter((p) => has(`${p.name} ${p.question} ${p.kinds.map((k) => k.label).join(" ")}`));
  const icon = Object.fromEntries(primitives.map((p) => [p.key, p]));
  const own = blocks.filter((b) => has(`${b.name} ${b.summary ?? ""}`));
  return <div className={css.menuBack} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={box} className={css.menu} role="dialog" aria-modal="true" aria-label="Add a step">
      <div className={css.menuHead}><b>{where?.at === "beside" ? "Add a step at the same time" : where?.at === "before" ? "Add a step before it" : "Add a step"}</b>
        <button type="button" className={css.close} onClick={onClose} aria-label="Close"><X size={15} /></button></div>
      <label className={css.palSearch}><Search size={14} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a step or a block" autoFocus aria-label="Find a step or a block" /></label>
      <div className={css.menuBody}>
        {prims.length ? <ul className={css.menuGrid}>{prims.map((p) => <li key={p.key}><button type="button" className={css.primItem} data-block={p.key} onClick={() => onPick(`block:${p.key}`)}>
          <span className={css.primIcon}><ModuleIcon name={p.icon} size={16} /></span><b>{p.name}</b><small>{p.question}</small></button></li>)}</ul> : null}
        {own.length ? <><h4>Your company’s blocks</h4><ul className={css.menuBlocks}>{own.map((b) => <li key={b.id}><button type="button" className={css.palItem} onClick={() => onPick(`preset:${b.id}`)}>
          <span className={css.palIcon} data-block={b.block}><ModuleIcon name={icon[b.block]?.icon} size={15} /></span>
          <span className={css.palText}><b>{b.name}</b><small>{icon[b.block]?.name ?? b.block}{b.summary ? ` · ${b.summary}` : ""}</small></span></button></li>)}</ul></> : null}
        {!prims.length && !own.length ? <p className={css.palNone}>Nothing matches “{q}”.</p> : null}
      </div>
    </div>
  </div>;
}

/** A value kept in this browser (localStorage), read without an effect; the server and the first paint see null. */
const listeners = new Set<() => void>();
export function store(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* private mode */ } listeners.forEach((f) => f()); }
export function useStored(key: string): string | null {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f); }; }, () => { try { return localStorage.getItem(key) ?? ""; } catch { return null; } }, () => null);
}
