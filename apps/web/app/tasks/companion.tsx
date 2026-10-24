"use client";
// UX-5B: the task companion. When someone leaves a task through "Go there", or keeps it with them, a small companion
// stays on screen as they move around Pulse: a small tab on the right edge (the page's own buttons stay free), opening to a card with the task,
// its steps, what Pulse is watching for, and Mark done. On a computer, "Open beside" shows the task in a resizable pane
// next to the page. It remembers the task per browser tab. When something connected to one of the person's open tasks
// changes, anywhere (this tab, another device, a colleague), the companion lights up and offers Mark done in one tap;
// when Pulse finished a task by itself it says so, with Undo.
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowRight, Check, ChevronLeft, CircleCheck, Eye, ListChecks, Minus, PanelRightClose, PanelRightOpen, Sparkles, Undo2, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { parseNotes } from "../lib/task-sense.mjs";
import { COMPANION_EVENT } from "../destinations/go";
import { goHref, said } from "../destinations/registry.mjs";
import { targetFor } from "../destinations/propose.mjs";
import { celebrate } from "./client";
import css from "./companion.module.css";

type CTask = { id: string; title: string; status: string; notes: string | null; doer: boolean; canEdit: boolean; requiresProof: boolean; proofs: number; openSubtasks: number; assigneeName: string | null; projectName: string | null };
type Signal = { id: string; event: string; label: string; need: number; seen: number; metAt: string | null };
type Auto = { id: string; at: string; prior: string; undoneAt: string | null; told: boolean } | null;
type Companion = { target: string | null; autoDone: boolean; confirmedAt: string | null; blocker: string | null; signals: Signal[]; auto: Auto };
type Data = { task: CTask; checks: string[]; companion: Companion };
type HitNote = { task: string; title: string; event: string; at: string; mine: boolean; actorName: string | null; /** The person an event is about (who arrived). */ subjectName?: string | null; doer: boolean; met: boolean; data?: Record<string, unknown> | null };
type AutoNote = { id: string; task: string; title: string; at: string; signals: string[] | null };
type Attention = { hits: HitNote[]; auto: AutoNote[] };
type View = "card" | "tab";
type Saved = { task: string | null; view: View; beside: boolean; width: number };

const KEY = "pulse.companion";
const OPEN = new Set(["open", "in_progress", "blocked", "unknown"]);
const STATUS: Record<string, string> = { open: "To do", in_progress: "Doing", blocked: "Blocked", done: "Done · waiting for review", in_review: "Done · waiting for review", accepted: "Accepted", cancelled: "Cancelled", unknown: "To do" };
const short = (t: string, n = 46) => t.length > n ? `${t.slice(0, n - 1)}…` : t;
const first = (name: string | null) => String(name ?? "Someone").split(" ")[0];
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
/** The tab's own memory; older values ("pill", "edge") are the tab. */
const load = (): Saved => { try { const s = { task: null, view: "tab", beside: false, width: 400, ...JSON.parse(sessionStorage.getItem(KEY) ?? "{}") }; return { ...s, view: s.view === "card" ? "card" : "tab" }; } catch { return { task: null, view: "tab", beside: false, width: 400 }; } };
/** A read, and whether the thing is gone (404, 403) rather than the network being away. */
const json = async <T,>(path: string): Promise<{ data: T | null; gone: boolean }> => {
  const r = await fetch(`/api/v0/${path}`, { cache: "no-store" }).catch(() => null);
  return { data: r?.ok ? await r.json() as T : null, gone: r?.status === 404 || r?.status === 403 };
};
const wide = () => typeof window !== "undefined" && window.matchMedia("(min-width: 1100px)").matches;

export function TaskCompanion({ role, modulesOff }: { role: string; modulesOff?: readonly string[] }) {
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();
  const [saved, setSaved] = useState<Saved>({ task: null, view: "tab", beside: false, width: 400 });
  const [data, setData] = useState<Data | null>(null);
  const [attention, setAttention] = useState<Attention>({ hits: [], auto: [] });
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // The tab's own memory, read after mount (sessionStorage does not exist on the server).
  // A task handed over meanwhile (a link opened with ?task=) wins over what the tab remembered.
  useEffect(() => { const f = requestAnimationFrame(() => setSaved((cur) => cur.task ? cur : load())); return () => cancelAnimationFrame(f); }, []);
  const save = useCallback((patch: Partial<Saved>) => setSaved((s) => { const next = { ...s, ...patch }; try { sessionStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ } return next; }), []);

  const refresh = useCallback(async (task: string | null) => {
    const [d, a] = await Promise.all([task ? json<Data>(`tasks/${task}/companion`) : Promise.resolve(null), json<Attention>("work/companion")]);
    if (!live.current) return;
    // A task deleted, or no longer visible, is let go of; a network blip keeps what was shown.
    if (d?.gone) { save({ task: null, beside: false }); setData(null); } else if (d?.data || !task) setData(d?.data ?? null);
    if (a.data) setAttention(a.data);
  }, [save]);
  // Keep the task the person came from; light up on any change made through Pulse, on focus and every half minute.
  useEffect(() => {
    const keep = (e: Event) => { const d = (e as CustomEvent<{ task?: string; open?: boolean }>).detail; if (d?.task) save({ task: d.task, view: d.open ? "card" : "tab" }); };
    window.addEventListener(COMPANION_EVENT, keep);
    return () => window.removeEventListener(COMPANION_EVENT, keep);
  }, [save]);
  useEffect(() => {
    let timer = 0;
    const soon = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { void refresh(saved.task); }, 250); };
    const visible = () => { if (document.visibilityState === "visible") soon(); };
    soon();
    const every = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(saved.task); }, 30000);
    window.addEventListener("pulse:data-changed", soon); window.addEventListener("focus", soon); document.addEventListener("visibilitychange", visible);
    return () => { window.clearTimeout(timer); window.clearInterval(every); window.removeEventListener("pulse:data-changed", soon); window.removeEventListener("focus", soon); document.removeEventListener("visibilitychange", visible); };
  }, [saved.task, refresh]);

  // "Open beside": the page makes room for the pane (desktop only).
  const beside = saved.beside && !!saved.task && !!data;
  useEffect(() => {
    const root = document.documentElement;
    if (!beside || !wide()) { root.removeAttribute("data-beside"); root.style.removeProperty("--pulse-beside"); return; }
    root.setAttribute("data-beside", ""); root.style.setProperty("--pulse-beside", `${saved.width}px`);
    return () => { root.removeAttribute("data-beside"); root.style.removeProperty("--pulse-beside"); };
  }, [beside, saved.width]);

  const task = data?.task && data.task.id === saved.task ? data.task : null;
  const steps = useMemo(() => parseNotes(task?.notes ?? null).steps, [task?.notes]);
  const ticked = new Set(data?.checks ?? []);
  const picked = data?.companion.target ?? null;
  const target = useMemo(() => task ? targetFor({ title: task.title, notes: task.notes, target: picked }, { role, modulesOff }) : null, [task, picked, role, modulesOff]);
  const onTaskPage = !!saved.task && pathname === `/tasks/${saved.task}`;
  // Already there: the target's page with every one of its query values.
  const onTarget = !!target && pathname === target.dest.href.split("?")[0] && [...new URLSearchParams(target.dest.href.split("?")[1] ?? "")].every(([k, v]) => params.get(k) === v);
  // RELEASE-5: one change can light up several of the person's tasks (two tasks waiting on the office Wi-Fi); the one
  // the companion holds (the task they came from, or went there for) speaks first.
  const hit = attention.hits.find((h) => h.task === saved.task) ?? attention.hits[0] ?? null; const auto = attention.auto.find((a) => a.task === saved.task) ?? attention.auto[0] ?? null;

  async function seen(id: string) { try { await post(`tasks/${id}/companion/seen`, {}); } catch { /* shown again next time */ } void refresh(saved.task); }
  async function markDone(t: { id: string; title: string; status?: string; openSubtasks?: number; requiresProof?: boolean; proofs?: number }) {
    // Subtasks and proof are settled on the task page (the same Done dialog), never skipped from here.
    if ((t.openSubtasks ?? 0) > 0 || (t.requiresProof && !t.proofs)) { router.push(`/tasks/${t.id}?finish=1`); return; }
    setBusy(true);
    try {
      const before = t.status && OPEN.has(t.status) ? t.status : "in_progress";
      const r = await post<{ weekDone?: number; streak?: number; released?: number }>(`tasks/${t.id}/move`, { status: "done" });
      await post(`tasks/${t.id}/companion/seen`, {}).catch(() => null);
      celebrate(r, t.title, null, () => { void post(`tasks/${t.id}/move`, { status: before }).then(() => { router.refresh(); void refresh(saved.task); }); });
      router.refresh(); void refresh(saved.task);
    } catch (e) { notify({ id: "companion-done", tone: "error", title: "Not marked done", message: msg(e) }); } finally { setBusy(false); }
  }
  async function undoAuto(id: string, title: string) {
    setBusy(true);
    try { await post(`tasks/${id}/auto-done/undo`, {}); notify({ id: "companion-undo", tone: "success", title: `Back to doing: ${short(title, 40)}`, timeout: 3000 }); router.refresh(); void refresh(saved.task); }
    catch (e) { notify({ id: "companion-undo", tone: "error", title: "Not undone", message: msg(e) }); } finally { setBusy(false); }
  }
  async function tick(key: string, label: string, on: boolean) {
    if (!task) return;
    try { await post(`tasks/${task.id}/checks`, { key, label, done: on }); void refresh(saved.task); } catch (e) { notify({ id: "companion-step", tone: "error", title: "Not saved", message: msg(e) }); }
  }

  // The attention bubble: one thing at a time, Pulse's own finish first.
  const bubble = auto ? <div className={css.bubble} role="region" aria-live="polite" aria-label="Pulse finished a task">
    <p><Sparkles size={14} aria-hidden="true" /><span>Pulse marked <b>“{short(auto.title, 60)}”</b> done{auto.signals?.length ? `: ${auto.signals.join("; ")}` : ""}.</span></p>
    <div className={css.bubbleActions}>
      <button type="button" className={css.ghost} disabled={busy} onClick={() => void undoAuto(auto.task, auto.title)}><Undo2 size={13} aria-hidden="true" />Undo</button>
      <button type="button" className={css.primary} disabled={busy} onClick={() => void seen(auto.task)}><Check size={13} aria-hidden="true" />OK</button>
    </div>
  </div> : hit ? <div className={css.bubble} role="region" aria-live="polite" aria-label="Connected to your task">
    <p><CircleCheck size={14} aria-hidden="true" /><span>{hit.mine ? "You" : first(hit.actorName ?? hit.subjectName ?? null)} {said(hit.event, hit.data)}. {hit.met ? "Everything it needs has happened. " : ""}Mark <b>“{short(hit.title, 60)}”</b> done?</span></p>
    <div className={css.bubbleActions}>
      <button type="button" className={css.ghost} disabled={busy} onClick={() => void seen(hit.task)}>Not yet</button>
      {hit.task !== saved.task ? <Link className={css.ghost} href={`/tasks/${hit.task}`} onClick={() => void seen(hit.task)}><Eye size={13} aria-hidden="true" />Open</Link> : null}
      <button type="button" className={css.primary} disabled={busy} onClick={() => void markDone(hit.task === task?.id && task ? task : { id: hit.task, title: hit.title, status: "in_progress" })}><Check size={13} aria-hidden="true" />Mark done</button>
    </div>
  </div> : null;

  if (!saved.task && !bubble) return null;
  if (onTaskPage && !bubble) return null;
  const lit = !!bubble;
  const finished = !!task && !OPEN.has(task.status);
  const canFinish = !!task && !finished && (task.doer || task.canEdit);
  const signals = data?.companion.signals ?? [];

  const body = task ? <>
    <p className={css.status}><span data-status={task.status}>{STATUS[task.status] ?? task.status}</span>{task.projectName ? <small>· {task.projectName}</small> : null}{!task.doer && task.assigneeName ? <small>· {first(task.assigneeName)} does it</small> : null}</p>
    {target && !onTarget ? <Link className={css.go} href={goHref(target.dest, task.id)}><ArrowRight size={14} aria-hidden="true" />{target.button}</Link> : null}
    {steps.length ? <ol className={css.steps} aria-label="Steps">{steps.map((s) => { const on = ticked.has(s.key); return <li key={s.key} data-done={on ? "" : undefined}>
      <button type="button" role="checkbox" aria-checked={on} disabled={!canFinish} onClick={() => void tick(s.key, s.text, !on)} aria-label={`Step ${s.n}: ${s.text}`}><Check size={12} strokeWidth={3} aria-hidden="true" /></button>
      <span>{s.text}</span></li>; })}</ol> : null}
    {signals.length ? <div className={css.signals} aria-label="What Pulse is watching for">
      <small><Sparkles size={12} aria-hidden="true" />{data?.companion.autoDone && data.companion.confirmedAt ? "Pulse finishes it when these happen" : "Pulse watches for"}</small>
      <ul>{signals.map((s) => <li key={s.id} data-met={s.metAt ? "" : undefined}><i aria-hidden="true">{s.metAt ? <Check size={11} strokeWidth={3} /> : null}</i><span>{s.label}</span>{s.need > 1 ? <b>{s.seen} of {s.need}</b> : null}</li>)}</ul>
    </div> : null}
    {data?.companion.auto && !data.companion.auto.undoneAt && finished ? <p className={css.note}>Pulse marked it done when everything above happened. <button type="button" className={css.link} disabled={busy} onClick={() => void undoAuto(task.id, task.title)}>Undo</button></p> : null}
  </> : <p className={css.note}>Loading the task…</p>;
  const foot = task ? <div className={css.foot}>
    {canFinish ? <button type="button" className={css.primary} disabled={busy} onClick={() => void markDone(task)}><Check size={14} aria-hidden="true" />Mark done</button> : null}
    <Link className={css.ghost} href={`/tasks/${task.id}`}>Open the task</Link>
  </div> : null;

  if (beside && task) return <BesidePane width={saved.width} onWidth={(width) => save({ width })} onClose={() => save({ beside: false })} onForget={() => { save({ task: null, beside: false }); setData(null); }} title={task.title} href={`/tasks/${task.id}`}>
    {bubble}{body}{foot}
  </BesidePane>;

  const open = saved.view === "card" && !!saved.task;
  const done = steps.length ? `${steps.filter((x) => ticked.has(x.key)).length}/${steps.length}` : signals.length ? `${signals.filter((x) => x.metAt).length}/${signals.length}` : null;
  return <div className={css.root} data-open={open ? "" : undefined} data-lit={lit ? "" : undefined} data-layout-ok="" data-float-avoid="" aria-label="Task companion" role="complementary">
    {open ? <section className={css.card} aria-label={task ? `Task: ${task.title}` : "Task"}>
      <header>
        <ListChecks size={16} aria-hidden="true" />
        <h2>{task ? <Link href={`/tasks/${task.id}`}>{task.title}</Link> : "Your task"}</h2>
        {task ? <button type="button" className={css.icon} onClick={() => save({ beside: true })} aria-label="Open beside the page" title="Open beside" data-wide-only=""><PanelRightOpen size={15} aria-hidden="true" /></button> : null}
        <button type="button" className={css.icon} onClick={() => save({ view: "tab" })} aria-label="Make it small" title="Make it small"><Minus size={15} aria-hidden="true" /></button>
        <button type="button" className={css.icon} onClick={() => { save({ task: null, view: "tab" }); setData(null); }} aria-label="Stop keeping this task with me" title="Close"><X size={15} aria-hidden="true" /></button>
      </header>
      <div className={css.cardBody}>{bubble}{body}</div>
      {foot}
    </section> : bubble}
    {/* The side tab: the task stays one tap away without covering the page's own buttons. */}
    {!open && saved.task ? <button type="button" className={css.tab} onClick={() => save({ view: "card" })} aria-expanded={false} aria-label={task ? `Task: ${task.title}. Open the companion` : "Open the companion"} title={task?.title}>
      <ChevronLeft size={13} aria-hidden="true" /><ListChecks size={17} aria-hidden="true" />{done ? <small>{done}</small> : null}{lit ? <i className={css.dot} aria-hidden="true" /> : null}</button> : null}
  </div>;
}

/** The task beside the page: a pane on the right that the page makes room for, resized by dragging its edge (or with
 *  the arrow keys on it), closed back into the companion. */
function BesidePane({ width, onWidth, onClose, onForget, title, href, children }: { width: number; onWidth: (w: number) => void; onClose: () => void; onForget: () => void; title: string; href: string; children: ReactNode }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.max(320, Math.min(Math.min(680, window.innerWidth * 0.5), w)));
  const down = (e: ReactPointerEvent<HTMLDivElement>) => { drag.current = { x: e.clientX, w: width }; e.currentTarget.setPointerCapture(e.pointerId); };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => { if (drag.current) onWidth(clamp(drag.current.w + (drag.current.x - e.clientX))); };
  const up = () => { drag.current = null; };
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); onWidth(clamp(width + (e.key === "ArrowLeft" ? 24 : -24))); } };
  return <aside className={css.pane} style={{ "--w": `${width}px` } as CSSProperties} aria-label={`Task beside the page: ${title}`} data-layout-ok="" data-float-sheet="">
    <div className={css.grip} role="separator" aria-orientation="vertical" aria-label="Resize the task pane" aria-valuemin={320} aria-valuemax={680} aria-valuenow={width} tabIndex={0}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} />
    <header>
      <ListChecks size={16} aria-hidden="true" />
      <h2><Link href={href}>{title}</Link></h2>
      <button type="button" className={css.icon} onClick={onClose} aria-label="Close the pane (keep the companion)" title="Close the pane"><PanelRightClose size={15} aria-hidden="true" /></button>
      <button type="button" className={css.icon} onClick={onForget} aria-label="Stop keeping this task with me" title="Close"><X size={15} aria-hidden="true" /></button>
    </header>
    <div className={css.paneBody}>{children}</div>
  </aside>;
}
