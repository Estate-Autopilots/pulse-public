"use client";
// FLOW-B: the process builder (owner, 21 Oct 2026: "workflow creation = adding things… certain modules connect to
// others"). The palette of modules on the left, the canvas of stages and steps in the middle, the inspector on the
// right. Every change is kept as a draft by itself (saved a moment after you stop) and can be undone; Go live makes it
// the version new runs follow. A package switch above the canvas greys out the steps that package skips.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, CloudOff, FlaskConical, List, ListTree, LoaderCircle, Map as MapIcon, Maximize2, Minimize2, Redo2, Rocket, Sparkles, Undo2, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { NODE, article, checkWire, fits, freeSpot, layout, moduleOf, newId, wireTo } from "../../lib/flow-canvas.mjs";
import { styles } from "../../ui";
import { flow, why } from "../flow-client";
import type { CompanyBlock, FlowDef, FlowStep, ModuleManifest, Primitive, Problem, ProcessDetail } from "../flow-types";
import { addBeside, appendTo, insertAfter, insertAfterRow, insertBefore, removeStep, swap } from "../../lib/flow-list.mjs";
import { Canvas, NEEDS_WHO, type CanvasApi, type Sel } from "./canvas";
import { FlowList, store, useStored, type Where } from "./list";
import { StepSheet } from "./sheet";
import { Inspector, type Hint } from "./inspector";
import { known } from "./known";
import { Palette } from "./palette";
import css from "./builder.module.css";

type Save = { state: "saved" | "dirty" | "saving" | "error"; error?: string; at?: number };
export type Intel = { problems?: Problem[]; people?: Record<string, { id: string; name: string; photoAt?: string | null; steps: number; hours: number; processes: number; warning: string | null }[]>;
  suggestions?: { step?: string; text: string; modules?: string[] }[] };

/** A definition as the canvas needs it: every list there, every step with a place. */
export function normal(d: Partial<FlowDef> | null | undefined): FlowDef {
  return { version: 2, fields: d?.fields ?? [], roles: d?.roles ?? [], stages: d?.stages ?? [], wires: d?.wires ?? [], rules: d?.rules ?? [], scorecard: d?.scorecard, clock: d?.clock ?? null, terms: d?.terms ?? null,
    steps: (d?.steps ?? []).map((s) => ({ ...s, who: s.who ?? { by: "role", role: null }, settings: s.settings ?? {}, pos: s.pos ?? { x: 0, y: 0 } })) };
}


/** A new step from a palette pick: a primitive ("block:write", its first kind) or a company block ("preset:<id>"). */
export function stepFrom(pick: string, d: FlowDef, primitives: Primitive[], blocks: CompanyBlock[], byKey: Record<string, ModuleManifest>): FlowStep | null {
  // A new step goes to whoever starts the run until someone says who does it (it works in Try it straight away).
  const id = newId(d), base = { id, title: "", stage: null, pos: { x: 0, y: 0 }, who: { by: "starter" as const } };
  if (pick.startsWith("preset:")) {
    const b = blocks.find((x) => x.id === pick.slice(7)); if (!b) return null;
    return { ...base, ...b.step, id, block: b.block, preset: b.key, settings: { ...(b.step.settings ?? {}) } } as FlowStep;
  }
  if (pick.startsWith("block:")) {
    const p = primitives.find((x) => x.key === pick.slice(6)); const k = p?.kinds[0]; if (!p || !k) return null;
    const m = byKey[k.module];
    return { ...base, block: p.key, module: k.module, settings: { ...(k.settings ?? {}) }, checklist: m?.defaults.checklist };
  }
  const m = byKey[pick]; if (!m) return null;
  return { ...base, who: { by: "role", role: null }, module: pick, settings: Object.fromEntries(m.settings.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])), checklist: m.defaults.checklist, qualityTest: m.defaults.qualityTest };
}

export function Builder({ process, modules, primitives = [], blocks: blocks0 = [], step }: { process: ProcessDetail; modules: ModuleManifest[]; primitives?: Primitive[]; blocks?: CompanyBlock[]; step?: string | null }) {
  const router = useRouter();
  const byKey = useMemo(() => known(modules, primitives), [modules, primitives]);
  const [blocks, setBlocks] = useState(blocks0);
  const readOnly = !process.canEdit || process.readOnly;
  const [def, setDef] = useState<FlowDef>(() => layout(normal(process.definition), byKey));
  const [name, setName] = useState(process.name), [summary, setSummary] = useState(process.summary ?? "");
  const [sel, setSel] = useState<Sel>(step ? { kind: "step", id: step } : null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [save, setSave] = useState<Save>({ state: "saved" });
  const [serverProblems, setServerProblems] = useState<Problem[]>(process.problems ?? []);
  const [going, setGoing] = useState(false);
  // The canvas fills the builder; the palette and the inspector float over it. The palette folds to a thin strip; the
  // inspector shows what is chosen, or the process itself when asked for (and when Go live finds something to fix).
  const [palette, setPalette] = useState(!readOnly), [overview, setOverview] = useState(false);
  // Owner, 21 Oct 2026: "a proper full screen mode, an infinite canvas, the sidebar out of the way". Full screen lays the
  // builder over the whole window (no app sidebar, no page header) and asks the browser for full screen too; the
  // Shift+F or the button switches it; Esc leaves it when nothing is chosen.
  const [full, setFull] = useState(false);
  const toggleFull = useCallback((on?: boolean) => setFull((was) => {
    const next = on ?? !was;
    try {
      if (next && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
      if (!next && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    } catch { /* not allowed here */ }
    return next;
  }), []);
  const hist = useRef<{ past: FlowDef[]; future: FlowDef[]; key: string | null; at: number }>({ past: [], future: [], key: null, at: 0 });
  const defRef = useRef(def);
  useLayoutEffect(() => { defRef.current = def; }, [def]);
  const canvas = useRef<CanvasApi>(null), search = useRef<HTMLInputElement>(null);
  const [depth, setDepth] = useState({ past: 0, future: 0 });
  const counted = () => setDepth({ past: hist.current.past.length, future: hist.current.future.length });

  // One change: kept for undo (typing in one field within a moment is one change), then saved as a draft.
  const edit = useCallback((fn: (d: FlowDef) => FlowDef, key?: string) => {
    const h = hist.current, now = Date.now();
    if (!(key && h.key === key && now - h.at < 1500)) { h.past.push(defRef.current); if (h.past.length > 120) h.past.shift(); h.future = []; }
    h.key = key ?? null; h.at = now;
    setDef((d) => fn(d)); setSave({ state: "dirty" }); counted();
  }, []);
  const undo = useCallback(() => { const h = hist.current, prev = h.past.pop(); if (!prev) return; h.future.push(defRef.current); h.key = null; setDef(prev); setSave({ state: "dirty" }); counted(); }, []);
  const redo = useCallback(() => { const h = hist.current, next = h.future.pop(); if (!next) return; h.past.push(defRef.current); h.key = null; setDef(next); setSave({ state: "dirty" }); counted(); }, []);

  // The draft saves itself a moment after the last change.
  // An SOP, workflow or board opened here is saved as a new process the first time (the old one stays, linked).
  const pid = useRef(process.id);
  const saveNow = useCallback(async () => {
    setSave({ state: "saving" });
    try {
      const r = await flow<Partial<ProcessDetail>>(`processes/${encodeURIComponent(pid.current)}`, "POST", { name: name.trim() || process.name, summary: summary.trim() || null, definition: defRef.current });
      if (r.problems) setServerProblems(r.problems);
      setSave({ state: "saved", at: Date.now() });
      if (r.id && r.id !== pid.current) { pid.current = r.id; router.replace(`/processes/${encodeURIComponent(r.id)}`, { scroll: false }); }
      // The page header (how many steps, written only / steps drafted) follows the draft.
      else if (defRef.current.steps.length !== process.steps) router.refresh();
      return true;
    } catch (e) { setSave({ state: "error", error: why(e) }); return false; }
  }, [process.name, process.steps, name, summary, router]);

  // Pip in the builder: the API's check of the whole draft (problems, converters) and people for each role by load.
  const [intel, setIntel] = useState<Intel | null>(null);
  const focus = sel?.kind === "step" ? sel.id : null;
  useEffect(() => {
    if (readOnly) return;
    let gone = false;
    const t = setTimeout(() => { flow<Intel>("check", "POST", { definition: defRef.current, stepId: focus }).then((r) => { if (!gone) setIntel(r); }).catch(() => {}); }, 900);
    return () => { gone = true; clearTimeout(t); };
  }, [def, focus, readOnly]);
  useEffect(() => {
    if (save.state !== "dirty" || readOnly) return;
    const t = setTimeout(() => void saveNow(), 1200); return () => clearTimeout(t);
  }, [save.state, def, name, summary, saveNow, readOnly]);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => { if (save.state === "dirty" || save.state === "saving") e.preventDefault(); };
    window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
  }, [save.state]);

  const roleLabel = useCallback((s: FlowStep) => s.who.by === "role" ? (s.who.role ? def.roles.find((r) => r.key === s.who.role)?.label ?? s.who.role : null)
    : s.who.by === "starter" ? "Whoever starts it" : s.who.by === "project_owner" ? "Project owner" : s.who.by === "pool" ? "The pool" : s.who.by === "person" ? "A person" : null, [def.roles]);

  // ---------------------------------------------------------------------------------------------- changes to steps
  // FLOW-D: a primitive or a company block added beside the chosen step comes after it (it starts when that one is done).
  const addStep = useCallback((key: string, at?: { x: number; y: number }, stage?: string | null) => {
    const d = defRef.current, near = sel?.kind === "step" ? d.steps.find((s) => s.id === sel.id) : undefined;
    const made = stepFrom(key, d, primitives, blocks, byKey); if (!made) return;
    const pos = at ?? freeSpot(d, byKey, near ? { x: near.pos.x + NODE.w + 56, y: near.pos.y } : { x: Math.max(0, ...d.steps.map((s) => s.pos.x + NODE.w + 56)), y: 72 });
    const step: FlowStep = { ...made, pos, stage: stage !== undefined ? stage : near?.stage ?? d.stages[0]?.key ?? null };
    const out = near ? moduleOf(near, byKey).makes[0] : undefined;
    const join = near && out && step.block && step.block !== "start" ? [{ from: { step: near.id, port: out.key }, to: { step: step.id, port: "in" } }] : [];
    edit((x) => ({ ...x, steps: [...x.steps, step], wires: [...x.wires, ...join] }));
    setSel({ kind: "step", id: step.id });
  }, [byKey, edit, sel, primitives, blocks]);

  /** Save a step as one of the company's blocks (it shows under "Your company's blocks" in every process). */
  const saveBlock = useCallback(async (s: FlowStep, name: string) => {
    try {
      const r = await flow<{ block: CompanyBlock }>("blocks", "POST", { name, summary: s.title || null, step: s });
      setBlocks((list) => [...list.filter((b) => b.key !== r.block.key), r.block].sort((a, z) => a.name.localeCompare(z.name)));
      notify({ id: "block", tone: "success", title: `Saved as a block: ${r.block.name}`, message: "It is under “Your company’s blocks” in every process.", timeout: 3500 });
      return true;
    } catch (e) { notify({ id: "block", tone: "error", title: "Not saved", message: why(e) }); return false; }
  }, []);

  const connect = useCallback((from: { step: string; port: string }, to: string, port: string | null) => {
    const r = wireTo(defRef.current, byKey, from, to, port);
    if (!r.ok) { notify({ id: "wire", tone: "info", title: r.why, timeout: 2500 }); return; }
    edit((d) => ({ ...d, wires: [...d.wires, { from, to: { step: to, port: r.port } }] }));
    if (!r.fits) setSel({ kind: "wire", index: defRef.current.wires.length });
  }, [byKey, edit]);

  /** Put a converter in the middle of a misfit wire: the wire becomes two that fit. */
  const convert = useCallback((index: number, key: string) => {
    const d = defRef.current, w = d.wires[index], m = byKey[key]; if (!w || !m) return;
    const c = checkWire(d, byKey, modules, w);
    const a = d.steps.find((s) => s.id === w.from.step), z = d.steps.find((s) => s.id === w.to.step); if (!a || !z) return;
    const id = newId(d), inn = m.needs.find((p) => fits(c.fromKind, p.kind)) ?? m.needs[0], out = m.makes.find((p) => fits(p.kind, c.toKind)) ?? m.makes[0];
    const pos = freeSpot(d, byKey, { x: (a.pos.x + z.pos.x) / 2, y: Math.max(a.pos.y, z.pos.y) + 140 });
    edit((x) => ({ ...x, steps: [...x.steps, { id, module: key, title: "", stage: z.stage ?? a.stage ?? null, who: a.who, settings: {}, pos, checklist: m.defaults.checklist }],
      wires: [...x.wires.filter((_, j) => j !== index), { ...w, to: { step: id, port: inn.key } }, { from: { step: id, port: out.key }, to: w.to }] }));
    setSel({ kind: "step", id });
    notify({ id: "conv", tone: "success", title: `${m.name} added: the wire fits now`, timeout: 2500 });
  }, [byKey, edit, modules]);

  const addBefore = useCallback((h: NonNullable<Hint["add"]>) => {
    const d = defRef.current, z = d.steps.find((s) => s.id === h.before), m = byKey[h.module]; if (!z || !m) return;
    const need = moduleOf(z, byKey).needs.find((p) => p.key === h.port);
    const out = m.makes.find((p) => need && fits(p.kind, need.kind)) ?? m.makes[0];
    const id = newId(d), pos = freeSpot(d, byKey, { x: z.pos.x - NODE.w - 56, y: z.pos.y });
    edit((x) => ({ ...x, steps: [...x.steps, { id, module: m.key, title: "", stage: z.stage ?? null, who: z.who, settings: {}, pos, checklist: m.defaults.checklist }],
      wires: [...x.wires, { from: { step: id, port: out.key }, to: { step: z.id, port: h.port } }] }));
    setSel({ kind: "step", id });
  }, [byKey, edit]);

  const remove = useCallback((s: Sel) => {
    if (!s || readOnly) return;
    // FLOW-D: what waited for the step waits for what came before it, so the order holds.
    if (s.kind === "step") edit((d) => removeStep(d, byKey, s.id));
    else edit((d) => ({ ...d, wires: d.wires.filter((_, j) => j !== s.index) }));
    setSel(null);
  }, [edit, readOnly, byKey]);

  // ------------------------------------------------------------------------------------------- FLOW-D: the list
  // The list is the default view (owner: "a simple list first, the canvas second"); the Map is the canvas.
  const kept = useStored("pulse.flow.view"), view: "list" | "map" = kept === "map" ? "map" : "list";
  const [flows, setFlows] = useState(false), [describing, setDescribing] = useState(false);
  const switchView = (v: "list" | "map") => { setSel(null); setOverview(false); store("pulse.flow.view", v); };
  const addAt = useCallback((where: Where, pick: string) => {
    const d = defRef.current; const made = stepFrom(pick, d, primitives, blocks, byKey); if (!made) return;
    const ref = "id" in where ? d.steps.find((x) => x.id === where.id) : "ids" in where ? d.steps.find((x) => x.id === where.ids[0]) : undefined;
    const pos = freeSpot(d, byKey, ref ? { x: ref.pos.x + (where.at === "beside" ? 0 : NODE.w + 56), y: ref.pos.y + (where.at === "beside" ? 160 : 0) } : { x: Math.max(0, ...d.steps.map((x) => x.pos.x + NODE.w + 56)), y: 72 });
    const step: FlowStep = { ...made, pos, stage: where.at === "stage" ? where.stage : ref?.stage ?? (where.at === "first" ? d.stages[0]?.key ?? null : null) };
    edit((x) => where.at === "after" ? insertAfter(x, byKey, where.id, step, where.port ?? null) : where.at === "beside" ? addBeside(x, byKey, where.id, step)
      : where.at === "row" ? insertAfterRow(x, byKey, where.ids, step) : where.at === "before" ? insertBefore(x, byKey, where.id, step)
        : where.at === "stage" ? appendTo(x, byKey, where.stage, step) : { ...x, steps: [...x.steps, step] });
    setSel({ kind: "step", id: step.id });
  }, [byKey, edit, primitives, blocks]);
  const dueLabel = useCallback((s: FlowStep) => {
    const d = s.due; if (!d) return null;
    const days = typeof d.days === "number" ? String(d.days) : Object.values(d.days).join(" / ");
    return d.from === "day1" ? `Day ${days}` : d.from.startsWith("step:") ? `${days} ${days === "1" ? "day" : "days"} after` : `within ${days} ${days === "1" ? "day" : "days"}`;
  }, []);

  // ------------------------------------------------------------------------------------------------ what to fix
  const problems = useMemo<Problem[]>(() => {
    const out: Problem[] = [];
    if (!def.steps.length) out.push({ level: "error", text: "Add how it starts, then its steps" });
    def.steps.forEach((s) => {
      const m = moduleOf(s, byKey), t = s.title || m.name;
      if (!byKey[s.module]) out.push({ level: "error", text: `“${t}” uses a module Pulse does not know`, step: s.id });
      if (s.who.by === "role" && !s.who.role && (!s.block || NEEDS_WHO.has(s.block))) out.push({ level: "error", text: `Say who does “${t}”`, step: s.id });
      const wired = new Set(def.wires.filter((w) => w.to.step === s.id).map((w) => w.to.port)), typed = new Set((s.inputs ?? []).map((x) => x.port));
      for (const p of m.needs) if (p.required && !wired.has(p.key) && !typed.has(p.key)) out.push({ level: "warning", text: `“${t}” needs ${article(p.kind)} (${p.label}) from somewhere`, step: s.id });
    });
    const named = (id: string) => { const s = def.steps.find((x) => x.id === id); return s ? s.title || moduleOf(s, byKey).name : "a step"; };
    def.wires.forEach((w, i) => { const c = checkWire(def, byKey, modules, w); if (!c.ok) out.push({ level: "error", text: `${named(w.from.step)} → ${named(w.to.step)}: ${(c.why ?? "the wire does not fit").replace(/^It/, "it")}`, wire: i }); });
    const seen = new Set(out.map((p) => p.text));
    const theirs = [...(intel?.problems ?? []), ...serverProblems].filter((p) => !seen.has(p.text) && (seen.add(p.text), true));
    return [...out, ...theirs].sort((a, z) => (a.level === "error" ? 0 : 1) - (z.level === "error" ? 0 : 1));
  }, [def, byKey, modules, serverProblems, intel]);

  const hints = useCallback((s: FlowStep): Hint[] => {
    const m = moduleOf(s, byKey), out: Hint[] = [];
    const wired = new Set(def.wires.filter((w) => w.to.step === s.id).map((w) => w.to.port)), typed = new Set((s.inputs ?? []).map((x) => x.port));
    for (const p of m.needs.filter((x) => x.required && !wired.has(x.key) && !typed.has(x.key))) {
      const maker = p.kind === "any" ? undefined : modules.filter((x) => x.key !== m.key && x.makes.some((o) => o.kind === p.kind) && (x.category !== "Start" || p.kind === "contact"))
        .sort((a, z) => Number(z.needs.length > 0) - Number(a.needs.length > 0) || ({ live: 0, partial: 1, stub: 2 }[a.engine] - { live: 0, partial: 1, stub: 2 }[z.engine]))[0];
      out.push({ key: `need-${p.key}`, text: `This needs ${article(p.kind)} (${p.label}). Join a step that makes one${maker ? `, or add a ${maker.name} before it` : ""}.`,
        add: maker ? { module: maker.key, label: `Add ${maker.name}`, before: s.id, port: p.key } : undefined });
    }
    if (s.who.by === "role" && !s.who.role) out.push({ key: "who", text: "Say who does it, so it lands on someone's My steps." });
    if (!s.due && m.category !== "Start") out.push({ key: "due", text: "Give it a due day so a late step shows up on the run." });
    if (!s.sop?.section && process.writeup.length) out.push({ key: "sop", text: "Link the part of the write-up that explains it: people see it beside the step." });
    for (const x of intel?.suggestions ?? []) if (x.step === s.id && !out.some((o) => o.text === x.text)) {
      const k = x.modules?.find((key) => byKey[key]), port = m.needs.find((p) => p.required && !wired.has(p.key) && !typed.has(p.key));
      out.push({ key: `api-${x.text}`, text: x.text, add: k && port ? { module: k, label: `Add ${byKey[k].name}`, before: s.id, port: port.key } : undefined });
    }
    const role = s.who.by === "role" && s.who.role ? intel?.people?.[s.who.role] : undefined;
    for (const p of role ?? []) if (p.warning) out.push({ key: `load-${p.id}`, text: `${p.warning}.` });
    return out;
  }, [def.wires, byKey, modules, process.writeup.length, intel]);

  // --------------------------------------------------------------------------------------------------- Go live
  const goLive = async () => {
    const errors = problems.filter((p) => p.level === "error");
    if (errors.length) { setSel(null); setOverview(true); notify({ id: "live", tone: "error", title: `Fix ${errors.length} ${errors.length === 1 ? "thing" : "things"} first`, message: errors[0].text }); return; }
    setGoing(true);
    try {
      if (save.state !== "saved" && !(await saveNow())) throw new Error("The draft did not save, so it cannot go live yet.");
      const r = await flow<{ problems?: Problem[]; version?: number }>(`processes/${encodeURIComponent(pid.current)}/publish`, "POST", {});
      if (r.problems?.some((p) => p.level === "error")) { setServerProblems(r.problems); setSel(null); setOverview(true); throw new Error(r.problems.find((p) => p.level === "error")!.text); }
      notify({ id: "live", tone: "success", title: "Live: new runs follow this version", message: "Runs already going keep the version they started with.", timeout: 4000 });
      router.refresh();
    } catch (e) { notify({ id: "live", tone: "error", title: "Not live yet", message: why(e) }); }
    finally { setGoing(false); }
  };

  // -------------------------------------------------------------------------------------------------- Try it
  // FLOW-D: the draft runs as a test project with sample data (each role a made-up person); nothing reaches anyone.
  const [trying, setTrying] = useState(false);
  const tryIt = async () => {
    const errors = problems.filter((p) => p.level === "error");
    if (errors.length) { notify({ id: "try", tone: "error", title: `Fix ${errors.length} ${errors.length === 1 ? "thing" : "things"} first`, message: errors[0].text }); return; }
    setTrying(true);
    try {
      if (save.state !== "saved" && !(await saveNow())) throw new Error("The draft did not save.");
      const d = defRef.current, soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const fields = Object.fromEntries(d.fields.filter((f) => f.type !== "person").map((f) => [f.key, f.type === "choice" ? values[f.key] || f.options?.[0]?.value : f.type === "boolean" ? false : f.type === "date" ? soon : f.type === "number" ? 1 : "Sample"]));
      const people = Object.fromEntries(d.roles.map((r) => [r.key, { name: `${r.label} (try)` }]));
      const r = await flow<{ id: string }>(`processes/${encodeURIComponent(pid.current)}/runs`, "POST", { mode: "try", name: `Try · ${name || process.name}`, fields, people });
      router.push(`/processes/${encodeURIComponent(pid.current)}/try/${r.id}`);
    } catch (e) { notify({ id: "try", tone: "error", title: "The test did not start", message: why(e) }); setTrying(false); }
  };

  // -------------------------------------------------------------------------------------------------- keyboard
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable]") )) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (mod) return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); remove(sel); return; }
      if (e.key === "Escape") { if (sel || overview) { setSel(null); setOverview(false); } else if (full) toggleFull(false); return; }
      if ((e.key === "F" || e.key === "f") && e.shiftKey) { e.preventDefault(); toggleFull(); return; }
      if (e.key === "/") { e.preventDefault(); setPalette(true); requestAnimationFrame(() => search.current?.focus()); return; }
      if (e.key === "f" || e.key === "F") { canvas.current?.fit(); return; }
      if (e.key === "+" || e.key === "=") { canvas.current?.zoomBy(1.2); return; }
      if (e.key === "-") { canvas.current?.zoomBy(1 / 1.2); return; }
      if (sel?.kind === "step" && !readOnly && e.key.startsWith("Arrow")) {
        e.preventDefault(); const n = e.shiftKey ? 40 : 8, dx = e.key === "ArrowLeft" ? -n : e.key === "ArrowRight" ? n : 0, dy = e.key === "ArrowUp" ? -n : e.key === "ArrowDown" ? n : 0;
        edit((d) => ({ ...d, steps: d.steps.map((s) => s.id === sel.id ? { ...s, pos: { x: s.pos.x + dx, y: s.pos.y + dy } } : s) }), `nudge-${sel.id}`);
      }
    };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [sel, overview, full, toggleFull, undo, redo, remove, edit, readOnly]);

  useEffect(() => {
    if (!full) return;
    const was = document.body.style.overflow; document.body.style.overflow = "hidden";
    const t = setTimeout(() => canvas.current?.fit(), 260);
    return () => { document.body.style.overflow = was; clearTimeout(t); };
  }, [full]);

  const variant = def.fields.find((f) => f.variant && f.type === "choice");
  const errors = problems.filter((p) => p.level === "error").length;
  const side = view === "map" && (!!sel || overview);
  const insets = { left: palette ? 268 : 64, right: side ? 344 : 0 };
  return <div className={css.builder} data-full={full ? "" : undefined}>
    <div className={css.toolbar}>
      {full ? <div className={css.fullHead}>
        <button type="button" className={css.iconBtn} onClick={() => toggleFull(false)} aria-label="Leave full screen" title="Leave full screen (Esc)"><Minimize2 size={16} /></button>
        <b title={name || process.name}>{name || process.name}</b>
        {process.status === "live" ? <span className={css.liveChip}>Live</span> : <span className={css.draftChip}>Draft</span>}
      </div> : null}
      <div className={css.leftTools}>
      <div className={css.viewSwitch} role="group" aria-label="How to show the steps">
        <button type="button" aria-pressed={view === "list"} onClick={() => switchView("list")}><List size={14} aria-hidden="true" />List</button>
        <button type="button" aria-pressed={view === "map"} onClick={() => switchView("map")}><MapIcon size={14} aria-hidden="true" />Map</button>
      </div>
      {view === "map" ? <label className={css.flowsToggle}><input type="checkbox" checked={flows} onChange={(e) => setFlows(e.target.checked)} />Show what flows</label> : null}
      {variant ? <div className={css.variant} role="group" aria-label={`Show the steps for a ${variant.label.toLowerCase()}`}>
        <button type="button" aria-pressed={!values[variant.key]} onClick={() => setValues({ ...values, [variant.key]: "" })}>Every step</button>
        {variant.options?.map((o) => <button key={o.value} type="button" aria-pressed={values[variant.key] === o.value} onClick={() => setValues({ ...values, [variant.key]: o.value })}>{o.label}</button>)}
      </div> : null}
      </div>
      <div className={css.tools}>
        {!full ? <button type="button" className={css.iconBtn} onClick={() => toggleFull(true)} aria-label="Full screen" title="Full screen (⇧F)"><Maximize2 size={16} /></button> : null}
        <button type="button" className={css.overviewBtn} aria-pressed={overview && !sel} onClick={() => { setSel(null); setOverview(!(overview && !sel)); }}>
          <ListTree size={15} aria-hidden="true" />Process{errors ? <em>{errors} to fix</em> : null}</button>
        {!readOnly ? <>
          <button type="button" className={css.iconBtn} onClick={undo} disabled={!depth.past} aria-label="Undo" title="Undo (⌘Z)"><Undo2 size={16} /></button>
          <button type="button" className={css.iconBtn} onClick={redo} disabled={!depth.future} aria-label="Redo" title="Redo (⇧⌘Z)"><Redo2 size={16} /></button>
          <span className={css.saved} data-state={save.state} role="status" title={save.state === "saved" ? "Draft saved" : undefined}>{save.state === "saving" || save.state === "dirty" ? <><LoaderCircle size={13} aria-hidden="true" className={css.spin} /><span className={css.savedText}>Saving the draft</span></>
            : save.state === "error" ? <><CloudOff size={13} aria-hidden="true" />Not saved <button type="button" onClick={() => void saveNow()}>Try again</button></>
              : <><CircleCheck size={13} aria-hidden="true" /><span className={css.savedText}>Draft saved</span></>}</span>
          <button type="button" className={styles.btn} onClick={() => void tryIt()} disabled={trying || !def.steps.length} title="Run it as a test with sample data: you act as each person"><FlaskConical size={14} aria-hidden="true" />{trying ? "Starting…" : "Try it"}</button>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void goLive()} disabled={going} title={errors ? `${errors} to fix first` : "New runs follow this version"}>
            <Rocket size={14} aria-hidden="true" />{going ? "Going live…" : process.status === "live" ? "Update live" : "Go live"}</button>
        </> : <span className={css.saved}>Read only</span>}
      </div>
    </div>
    {view === "list" ? <div className={css.listBody}>
      <FlowList def={def} byKey={byKey} primitives={primitives} blocks={blocks} sel={sel?.kind === "step" ? sel.id : null} onSelect={(id) => setSel(id ? { kind: "step", id } : null)} readOnly={readOnly}
        problems={problems} values={values} roleLabel={roleLabel} dueLabel={dueLabel} onAdd={addAt} onDescribe={() => setDescribing(true)} onStage={(fn) => edit(fn)} />
      {sel?.kind === "step" && def.steps.some((x) => x.id === sel.id) ? <StepSheet key={sel.id} step={def.steps.find((x) => x.id === sel.id)!} def={def} byKey={byKey} primitives={primitives} edit={edit} writeup={process.writeup}
        problems={problems.filter((p) => p.step === sel.id)} people={intel?.people ?? null} readOnly={readOnly} onClose={() => setSel(null)} onSaveBlock={saveBlock}
        onRemove={() => remove(sel)} onMove={(dir) => edit((d) => swap(d, byKey, sel.id, dir))} onAddBefore={(pick) => addAt({ at: "before", id: sel.id }, pick)} onAddAfter={(pick) => addAt({ at: "after", id: sel.id }, pick)} /> : null}
    </div> : <div className={css.body} style={{ "--pl": `${insets.left}px`, "--pr": `${insets.right}px` } as React.CSSProperties}>
      <Palette primitives={primitives} blocks={blocks} onAdd={(k) => addStep(k)} search={search} readOnly={readOnly} open={palette} onOpen={setPalette} />
      <Canvas api={canvas} insets={insets} def={flows ? def : { ...def, wires: gatesOnly(def, byKey) }} compact={!flows} byKey={byKey} modules={modules} sel={sel} onSelect={setSel} values={values} roleLabel={roleLabel} readOnly={readOnly}
        onMoveStart={() => edit((d) => d)} onMove={(id, pos) => setDef((d) => ({ ...d, steps: d.steps.map((s) => s.id === id ? { ...s, pos } : s) }))}
        onMoveEnd={(id, stage) => { if (stage !== null) setDef((d) => ({ ...d, steps: d.steps.map((s) => s.id === id && s.stage !== stage ? { ...s, stage: stage || null } : s) })); setSave({ state: "dirty" }); }}
        onConnect={connect} onDropModule={(k, at, stage) => addStep(k, at, stage)} onConvert={convert} onTidy={() => { edit((d) => layout(d, byKey, true)); requestAnimationFrame(() => canvas.current?.fit()); }} />
      {side ? <Inspector onClose={() => { setSel(null); setOverview(false); }} people={intel?.people ?? null} def={def} byKey={byKey} modules={modules} sel={sel} onSelect={(s) => { setSel(s); if (s?.kind === "step") canvas.current?.center(s.id); }} edit={edit} writeup={process.writeup}
        problems={problems} hints={hints} name={name} summary={summary} onName={(v) => { setName(v); setSave({ state: "dirty" }); }} onSummary={(v) => { setSummary(v); setSave({ state: "dirty" }); }}
        readOnly={readOnly} onDelete={remove} onAddBefore={addBefore} onConvert={convert} primitives={primitives} onSaveBlock={saveBlock} /> : null}
    </div>}
    {describing ? <Describe title={name || process.name} has={def.steps.length} onClose={() => setDescribing(false)}
      onDraft={(draft) => { edit((d) => layout({ ...d, roles: [...d.roles, ...draft.roles.filter((r) => !d.roles.some((x) => x.key === r.key))], stages: draft.stages.length ? draft.stages : d.stages,
        steps: draft.steps.map((x) => ({ ...x, pos: { x: NaN, y: NaN } })), wires: draft.wires }, byKey, true)); setDescribing(false); switchView("list"); }} /> : null}
  </div>;
}

/** FLOW-D: the Map without "Show what flows": only the wires that decide the order. */
function gatesOnly(def: FlowDef, byKey: Record<string, ModuleManifest>) {
  return def.wires.filter((w) => { const b = def.steps.find((s) => s.id === w.to.step); if (!b) return false; if (b.block) return w.to.port === "in";
    const need = (byKey[b.module]?.needs ?? []).find((n) => n.key === w.to.port); return !need || need.required !== false; });
}

/** "Describe it": how the work goes in someone's own words; Pip drafts the steps, who and when; the person edits them. */
function Describe({ title, has, onClose, onDraft }: { title: string; has: number; onClose: () => void; onDraft: (d: FlowDef) => void }) {
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [notes, setNotes] = useState<string[] | null>(null), [draft, setDraft] = useState<FlowDef | null>(null);
  const ask = async () => {
    setBusy(true);
    try { const r = await flow<{ definition: FlowDef; notes: string[] }>("describe", "POST", { text, title }); setNotes(r.notes); setDraft(r.definition); }
    catch (e) { notify({ id: "describe", tone: "error", title: "Pip could not read it", message: why(e) }); }
    finally { setBusy(false); }
  };
  return <div className={css.menuBack} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={css.menu} role="dialog" aria-modal="true" aria-label="Describe how the work goes">
      <div className={css.menuHead}><b><Sparkles size={15} aria-hidden="true" /> Describe how the work goes</b><button type="button" className={css.close} onClick={onClose} aria-label="Close"><X size={15} /></button></div>
      <div className={css.describe}>
        <textarea value={text} onChange={(e) => { setText(e.target.value); setDraft(null); setNotes(null); }} autoFocus maxLength={100000}
          placeholder={"Say it the way you would to a new colleague. For example:\nWhen a new lead comes in, the sales executive calls them within a day. Then the site surveyor visits the site and takes photos. The sales executive sends the quotation within 2 days. If the customer approves, the install team installs; otherwise the sales executive follows up. Accounts makes the invoice."} />
        {notes ? <ul aria-label="What Pip did">{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        <div className={css.emptyActions}>
          {draft ? <button type="button" className={css.primaryBtn} onClick={() => onDraft(draft)}>{has ? `Use these ${draft.steps.length} steps (replaces the ${has} there)` : `Use these ${draft.steps.length} steps`}</button>
            : <button type="button" className={css.primaryBtn} onClick={() => void ask()} disabled={busy || text.trim().length < 8}><Sparkles size={14} aria-hidden="true" />{busy ? "Pip is reading…" : "Draft the steps"}</button>}
          {draft ? <button type="button" className={css.saveBlock} onClick={() => void ask()} disabled={busy}>Read it again</button> : null}
        </div>
      </div>
    </div>
  </div>;
}
