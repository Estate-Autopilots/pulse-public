"use client";
// TASKS-3: My tasks as one calm list. Nothing hides behind a tab: what needs you comes first, then Overdue, Today, This
// week, Later, No date and Blocked; the pills only narrow it. A tick fills, the row says thank you and folds away (with
// Undo). Rename, the due day and the project change in place; select several (or shift-click a range) and one bar moves,
// dates, gives or finishes them all.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { CalendarDays, Check, ChevronDown, Flag, FolderKanban, Hourglass, ListTree, MessageSquare, Pencil, SquareCheck, Trash2, Undo2, UserRound, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { PersonPicker, useWorkOptions, type Person } from "../create";
import { Modal, post } from "../records";
import { Avatar, styles } from "../ui";
import { ByDevice, Select } from "../kit";
import { nextUp } from "../lib/task-sense.mjs";
import { LENSES, firstLens, inLens, lensCount, lensRows, type Lens } from "../lib/task-lens.mjs";
import { AcceptButton, celebrate } from "./client";
import { timingOf, waitedFor } from "./life-words";
import { PRIORITY, STATUS, shortDay } from "./parts";
import { MoveDialog } from "./task-people";
import { DeleteDialog } from "./delete";
import type { Home, Task } from "./types";
import type { Ask } from "./work-client";
import { zoneDay } from "../lib/zone.mjs";
import { useOrgZone } from "../org-code";
import css from "./work3.module.css";
import { armedClass, tickDone, tickProps, useArmedTask } from "./confirm-done";
import { DateField } from "../kit/date-field";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const first = (name: string | null | undefined) => String(name ?? "").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const FINISHED = ["done", "in_review", "accepted"];
const NEEDS_KEY = "pulse.tasks.needs-you";
const noSubscribe = () => () => {};
const readNeeds = () => { try { return localStorage.getItem(NEEDS_KEY); } catch { return null; } };
const RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

type SectionKey = "overdue" | "today" | "week" | "later" | "none" | "blocked" | "done";
const SECTIONS: { key: SectionKey; label: string; tone?: string; empty?: string }[] = [
  { key: "overdue", label: "Overdue", tone: "late" }, { key: "today", label: "Today", tone: "now" }, { key: "week", label: "This week" },
  { key: "later", label: "Later" }, { key: "none", label: "No date" }, { key: "blocked", label: "Blocked" }, { key: "done", label: "Done" },
];
const FILTERS = [{ key: "open", label: "Open" }, { key: "today", label: "Today" }, { key: "week", label: "This week" }, { key: "blocked", label: "Blocked" }, { key: "done", label: "Done" }] as const;
type Filter = typeof FILTERS[number]["key"];
const SHOWN: Record<Filter, SectionKey[]> = { open: ["overdue", "today", "week", "later", "none", "blocked"], today: ["overdue", "today"], week: ["overdue", "today", "week"], blocked: ["blocked"], done: ["done"] };

function sectionOf(t: Task, today: string, weekEnd: string): SectionKey {
  if (FINISHED.includes(t.status)) return "done";
  if (t.status === "blocked" || t.openBlockers > 0) return "blocked";
  if (t.dueOn && t.dueOn < today) return "overdue";
  if (t.status === "in_progress" || t.dueOn === today) return "today";
  if (!t.dueOn) return "none";
  return t.dueOn <= weekEnd ? "week" : "later";
}
function dueWords(t: Task, today: string): { text: string; tone?: string } | null {
  if (!t.dueOn) return null;
  const d = Math.round((Date.parse(`${t.dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (d < 0) return { text: d === -1 ? "Yesterday" : `${-d} days late`, tone: "late" };
  if (d === 0) return { text: "Today", tone: "now" };
  if (d === 1) return { text: "Tomorrow", tone: "soon" };
  return { text: d < 7 ? shortDay(t.dueOn).slice(0, 3) : shortDay(t.dueOn) };
}

/** The days a due-date menu offers, from today (IST). */
function dayChoices(today: string) {
  const fri = addDays(today, ((5 - weekday(today) + 7) % 7) || 7), mon = addDays(today, ((1 - weekday(today) + 7) % 7) || 7);
  return [["Today", today], ["Tomorrow", addDays(today, 1)], [`Friday`, fri], ["Next week", mon]] as [string, string][];
}

/** A small popover anchored to its button; closes on Escape or a click outside. */
function Pop({ label, button, children, up, right }: { label: string; button: (open: () => void, expanded: boolean) => ReactNode; children: (close: () => void) => ReactNode; up?: boolean; right?: boolean }) {
  const [open, setOpen] = useState(false); const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", key, true);
    wrap.current?.querySelector<HTMLElement>("[role=menu] button")?.focus();
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key, true); };
  }, [open]);
  return <span className={css.popWrap} ref={wrap}>{button(() => setOpen(!open), open)}
    {open ? <div className={css.pop} role="menu" aria-label={label} data-up={up ? "" : undefined} data-right={right ? "" : undefined}>{children(() => setOpen(false))}</div> : null}</span>;
}
function DueMenu({ today, current, onPick, close }: { today: string; current: string | null; onPick: (day: string | null) => void; close: () => void }) {
  return <>
    {dayChoices(today).map(([l, d]) => <button key={l} type="button" role="menuitem" onClick={() => { close(); onPick(d); }}><CalendarDays size={14} aria-hidden="true" />{l}<small>{shortDay(d)}</small></button>)}
    <label><DateField aria-label="Pick a day" min={today} defaultValue={current ?? ""} onChange={(e) => { if (e.target.value) { close(); onPick(e.target.value); } }} /></label>
    {current ? <><hr /><button type="button" role="menuitem" onClick={() => { close(); onPick(null); }}><X size={14} aria-hidden="true" />No due date</button></> : null}
  </>;
}

function Rename({ title, onSave, onCancel }: { title: string; onSave: (title: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(title); const done = useRef(false);
  const key = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") { e.preventDefault(); done.current = true; onSave(text); } else if (e.key === "Escape") { e.preventDefault(); done.current = true; onCancel(); } };
  return <input className={css.rename} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={key} onBlur={() => { if (!done.current) onSave(text); }} autoFocus maxLength={300} aria-label="Task name" />;
}

/** One task: tick, title (rename in place), and its facts as small controls. */
function Row({ t, today, me, selected, leaving, renaming, onTick, onSelect, onRename, onSaveTitle, onDue, onMove, done }: {
  t: Task; today: string; me: string | null; selected: boolean; leaving: boolean; renaming: boolean; done: boolean;
  onTick: () => void; onSelect: (e: { shiftKey: boolean }) => void; onRename: (on: boolean) => void; onSaveTitle: (title: string) => void; onDue: (day: string | null) => void; onMove: () => void;
}) {
  const finished = FINISHED.includes(t.status) || done;
  const due = finished ? null : dueWords(t, today);
  const st = STATUS[t.status] ?? STATUS.unknown;
  const asking = useArmedTask() === t.id, tick = tickProps(t.title, asking);
  // MY-TASKS: someone else's task (one you created or review) shows who has it in place of the tick.
  const foreign = !!me && t.assigneeId !== me;
  const from = !foreign && t.assignerId && t.assignerId !== me ? t.assignerName : null;
  return <li className={css.row} data-selected={selected ? "" : undefined} data-leaving={leaving ? "" : undefined} data-done={finished ? "" : undefined} data-priority={t.priority} data-task={t.id}>
    <div className={css.rowInner}>
      <label className={css.select} title="Select"><input type="checkbox" checked={selected} onChange={() => undefined} onClick={(e) => onSelect({ shiftKey: e.shiftKey })} aria-label={`Select “${t.title}”`} /></label>
      {foreign ? <span className={css.whoHas} title={t.assigneeName ? `${t.assigneeName} has it` : "Nobody has it yet"}>
        {t.assigneeName ? <Avatar name={t.assigneeName} id={t.assigneeId ?? undefined} photoAt={t.assigneePhotoAt} size={22} /> : <UserRound size={14} aria-hidden="true" />}</span>
      : <button type="button" className={asking ? `${css.tick} ${armedClass}` : css.tick} data-done={finished ? "" : undefined} data-pop={done ? "" : undefined} data-armed={asking ? "" : undefined}
        onClick={() => tickDone(t.id, t.title, onTick)} disabled={finished}
        aria-label={finished ? `${t.title}: ${st.label}` : tick.label} title={finished ? st.label : tick.tip}><Check size={13} strokeWidth={3} aria-hidden="true" /></button>}
      <div className={css.rowMain}>
        {renaming ? <Rename title={t.title} onSave={onSaveTitle} onCancel={() => onRename(false)} />
          : <Link href={`/tasks/${t.id}`} className={css.title} title={t.title}>{t.title}</Link>}
        <span className={css.meta}>
          {from ? <span className={css.fromFact} title={`${from} gave you this`}><Avatar name={from} id={t.assignerId ?? undefined} photoAt={t.assignerPhotoAt} size={18} />From {first(from)}</span>
            : !foreign && !t.assignerId && t.source !== "pulse" ? <span className={css.fact}>From the tracker</span> : null}
          {foreign ? <span className={css.fact}>{t.assigneeName ? `${first(t.assigneeName)} has it` : t.poolScope ? "In the pool" : "Nobody has it yet"}</span> : null}
          {t.status === "in_progress" && !finished ? <span className={css.fact} data-tone="accent">Doing</span> : null}
          {t.status === "blocked" || t.openBlockers > 0 ? <span className={css.fact} data-tone="late"><Hourglass size={11} aria-hidden="true" />{t.openBlockers ? `Waiting on ${t.openBlockers}` : "Blocked"}</span> : null}
          {!finished ? <Pop label={`Due day for “${t.title}”`} button={(toggle, expanded) => <button type="button" className={css.fact} data-tone={due?.tone} data-empty={due ? undefined : ""} onClick={toggle} aria-expanded={expanded} aria-label={due ? `Due ${due.text}: change` : "Set a due day"}>
            <CalendarDays size={11} aria-hidden="true" /><span>{due?.text ?? "Due"}</span></button>}>{(close) => <DueMenu today={today} current={t.dueOn} onPick={onDue} close={close} />}</Pop> : null}
          {t.priority === "urgent" || t.priority === "high" ? <span className={css.fact} data-tone={t.priority === "urgent" ? "late" : "warning"}><Flag size={11} aria-hidden="true" />{PRIORITY[t.priority]}</span> : null}
          {t.projectName ? <button type="button" className={css.fact} onClick={onMove} title={`${t.projectName}: move to another project`}><FolderKanban size={11} aria-hidden="true" /><span>{t.projectName}</span></button>
            : !finished ? <button type="button" className={css.fact} data-empty="" onClick={onMove} aria-label="Put it in a project"><FolderKanban size={11} aria-hidden="true" /><span>Project</span></button> : null}
          {t.tags?.slice(0, 3).map((g) => <span key={g} className={css.fact}>#{g}</span>)}
          {t.status === "accepted" ? <span className={css.fact} data-tone="success"><Check size={11} aria-hidden="true" />Accepted</span>
            : t.status === "done" || t.status === "in_review" ? <span className={css.fact}>{t.reviewerName ? `Waiting for ${first(t.reviewerName)}` : "Waiting for review"}</span> : null}
          {t.subtasks ? <span className={css.fact}><ListTree size={11} aria-hidden="true" />{t.subtasksDone}/{t.subtasks}</span> : null}
          {t.comments ? <span className={css.fact}><MessageSquare size={11} aria-hidden="true" />{t.comments}</span> : null}
        </span>
      </div>
      <span className={css.end}>
        {!finished && !renaming ? <span className={css.hover}><button type="button" className={css.iconBtn} onClick={() => onRename(true)} aria-label={`Rename “${t.title}”`} title="Rename"><Pencil size={14} aria-hidden="true" /></button></span> : null}
      </span>
    </div>
  </li>;
}

/** A request in the Needs you block: the person asked answers here (Decline asks for an optional line); the sender withdraws. */
function AskRow({ ask }: { ask: Ask }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [done, setDone] = useState(""), [declining, setDeclining] = useState(false), [note, setNote] = useState("");
  async function act(key: string) {
    const a = ask.actions.find((x) => x.key === key); if (!a) return; setBusy(true);
    try { await post(a.path.replace(/^\/api\/v0\//, ""), key === "decline" ? { note } : {}); setDone(key === "accept" ? (ask.kind === "take" ? "It’s yours" : "Accepted") : key === "decline" ? "Declined" : "Withdrawn"); router.refresh(); }
    catch (e) { notify({ id: `ask:${ask.id}`, tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  const accept = ask.actions.find((a) => a.key === "accept");
  return <li className={css.need}>
    <Avatar name={ask.incoming ? ask.fromName : ask.toName} id={ask.incoming ? ask.fromId : ask.toId} photoAt={ask.incoming ? ask.fromPhotoAt : null} size={28} />
    <span className={css.needMain}><b title={ask.title}>{ask.title}</b><small>{ask.note ? `“${ask.note}”` : ask.incoming ? (ask.kind === "take" ? "Taking it makes it yours; they review it when you are done." : "Accept to work on it with them.") : "Waiting for their answer."}</small></span>
    <span className={css.needActions}>{done ? <span className={css.fact} data-tone="success"><Check size={11} aria-hidden="true" />{done}</span>
      : ask.incoming ? declining ? <form className={css.declineForm} onSubmit={(e) => { e.preventDefault(); void act("decline"); }}><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="A short reason (optional)" aria-label="Reason for declining" autoFocus maxLength={500} />
          <button className={styles.btn} disabled={busy}>Decline</button><button type="button" className={css.iconBtn} aria-label="Back" onClick={() => setDeclining(false)}><X size={14} aria-hidden="true" /></button></form>
        : <><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void act("accept")}><Check size={13} aria-hidden="true" />{accept?.label ?? "Accept"}</button>
          <button type="button" className={styles.btn} disabled={busy} onClick={() => setDeclining(true)}>Decline</button></>
      : ask.actions.some((a) => a.key === "withdraw") ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void act("withdraw")}>Withdraw</button> : null}</span>
  </li>;
}

/** Choose someone for several tasks at once. */
function GiveMany({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const { data } = useWorkOptions(); const [busy, setBusy] = useState(false); const router = useRouter();
  async function pick(p: Person | null) {
    if (!p || busy) return; setBusy(true);
    try { const r = await post<{ changed: number; asked: number; failed: { title: string | null; error: string }[] }>("work/tasks/bulk", { ids, set: { assigneeId: p.id } });
      notify({ id: "bulk", tone: r.failed.length ? "error" : "success", title: r.asked ? `Asked ${first(p.name)} to take ${r.asked}` : `${first(p.name)} does ${r.changed} now`,
        message: r.failed[0] ? `${r.failed[0].title ?? "A task"}: ${r.failed[0].error}` : undefined, timeout: 3800 }); onDone(); onClose(); router.refresh(); }
    catch (e) { notify({ id: "bulk", tone: "error", title: "Not given", message: msg(e) }); } finally { setBusy(false); }
  }
  return <Modal title={`Who does these ${ids.length}?`} sub="People inside your reach get them at once; anyone else is asked." onClose={onClose}>
    <div className={css.dialogBody}>{data ? <PersonPicker people={data.people} value={null} onChange={pick} me={data.me} label="Who does it" showAsk autoFocus /> : <p className={styles.muted}>Loading people…</p>}</div>
  </Modal>;
}

export function MyWork({ home, asks, initialTab, initialLens }: { home: Home; asks: Ask[]; initialTab?: string; initialLens?: string }) {
  const router = useRouter();
  const today = home.today, weekEnd = addDays(home.week, 6), me = home.me;
  const [now] = useState(() => Date.now());
  // MY-TASKS: my rows, what I created for others and what I review, so each lens is a filter over one list.
  const everything = useMemo(() => lensRows(home), [home]);
  const [all, setRows] = useState(everything), [base, setBase] = useState(everything);
  if (base !== everything) { setBase(everything); setRows(everything); }
  // "Assigned to me" opens first; someone with nothing from anyone else opens on everything they have.
  const [lens, setLens] = useState<Lens>(() => firstLens(initialLens, everything, me));
  const rows = useMemo(() => all.filter((t) => inLens(lens, t, me)), [all, lens, me]);
  const [filter, setFilter] = useState<Filter>(() => (FILTERS.find((f) => f.key === initialTab)?.key ?? (initialTab === "today" ? "today" : "open")) as Filter);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [anchor, setAnchor] = useState<string | null>(null), [selecting, setSelecting] = useState(false);
  const [leaving, setLeaving] = useState<Set<string>>(new Set()), [justDone, setJustDone] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null), [moving, setMoving] = useState<string[] | null>(null), [giving, setGiving] = useState<string[] | null>(null), [deleting, setDeleting] = useState<string[] | null>(null);
  const [folded, setFolded] = useState<Set<SectionKey>>(new Set()), [doneShown, setDoneShown] = useState(20);
  const [busy, setBusy] = useState(false), [allNeeds, setAllNeeds] = useState(false);
  // STAFF-UX (owner, 28 Oct 2026: "ribbons under ribbons, my work is pushed to the bottom half"): Needs you and Waiting for
  // an answer fold to one line each (what is in them, in numbers) so the person's own list starts near the top; a tap
  // opens them and the choice is kept on this device.
  const [needsOpen, setNeedsOpen] = useState<boolean | null>(null);
  const savedNeeds = useSyncExternalStore(noSubscribe, readNeeds, () => null);
  const foldNeeds = (open: boolean) => { setNeedsOpen(open); try { localStorage.setItem(NEEDS_KEY, open ? "open" : "folded"); } catch { /* private mode */ } };

  const sections = useMemo(() => {
    const out = Object.fromEntries(SECTIONS.map((s) => [s.key, [] as Task[]])) as Record<SectionKey, Task[]>;
    for (const t of rows) if (t.status !== "cancelled") out[justDone.has(t.id) ? sectionOf({ ...t, status: "open" }, today, weekEnd) : sectionOf(t, today, weekEnd)].push(t);
    for (const k of Object.keys(out) as SectionKey[]) if (k !== "done") out[k].sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") || RANK[a.priority] - RANK[b.priority] || a.title.localeCompare(b.title));
    out.done.sort((a, b) => String(b.doneAt ?? b.workOn ?? "").localeCompare(String(a.doneAt ?? a.workOn ?? "")));
    return out;
  }, [rows, today, weekEnd, justDone]);
  const waitingOnMe = useMemo(() => { const m = new Map<string, Home["waitingOnMe"][number] & { needs: string[] }>(); for (const t of home.waitingOnMe) { const s = m.get(t.id); if (s) s.needs.push(t.blockerTitle); else m.set(t.id, { ...t, needs: [t.blockerTitle] }); } return [...m.values()]; }, [home.waitingOnMe]);
  const count = (f: Filter) => SHOWN[f].reduce((n, k) => n + sections[k].length, 0);
  const visible = SHOWN[filter].flatMap((k) => folded.has(k) ? [] : k === "done" ? sections.done.slice(0, doneShown) : sections[k]);
  const selectedList = [...selected].filter((id) => rows.some((r) => r.id === id));

  function choose(f: Filter) { setFilter(f); const q = new URLSearchParams(window.location.search); q.set("tab", f); window.history.replaceState(null, "", `/tasks?${q}`); }
  function look(l: Lens) { setLens(l); setSelected(new Set()); const q = new URLSearchParams(window.location.search); q.set("lens", l); window.history.replaceState(null, "", `/tasks?${q}`); }
  function toggle(id: string, shift: boolean) {
    const next = new Set(selected);
    if (shift && anchor) { const ids = visible.map((t) => t.id); const a = ids.indexOf(anchor), b = ids.indexOf(id); if (a >= 0 && b >= 0) { for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x); setSelected(next); return; } }
    if (next.has(id)) next.delete(id); else next.add(id); setSelected(next); setAnchor(id);
  }
  async function tick(t: Task) {
    if (FINISHED.includes(t.status) || justDone.has(t.id)) return;
    const was = t.status;
    setJustDone((s) => new Set(s).add(t.id));
    try {
      const r = await post<{ weekDone?: number; streak?: number; released?: number }>(`tasks/${t.id}/move`, { status: "done" });
      celebrate(r, t.title, nextUp(rows.filter((x) => x.id !== t.id), t.id),
        () => { void post(`tasks/${t.id}/move`, { status: was === "unknown" ? "open" : was }).then(() => router.refresh()).catch((e) => notify({ id: "undo", tone: "error", title: "Not undone", message: msg(e) })); });
      setLeaving((s) => new Set(s).add(t.id));
      setTimeout(() => { setRows((all) => all.map((x) => x.id === t.id ? { ...x, status: "done", doneAt: new Date().toISOString() } : x)); setJustDone((s) => { const n = new Set(s); n.delete(t.id); return n; }); setLeaving((s) => { const n = new Set(s); n.delete(t.id); return n; }); router.refresh(); }, 760);
    } catch (e) { setJustDone((s) => { const n = new Set(s); n.delete(t.id); return n; }); notify({ id: "task-move", tone: "error", title: "Not marked done", message: msg(e) }); }
  }
  async function save(t: Task, body: Record<string, unknown>, ok?: string) {
    const before = rows; setRows((all) => all.map((x) => x.id === t.id ? { ...x, ...("dueOn" in body ? { dueOn: body.dueOn as string | null } : {}), ...("title" in body ? { title: String(body.title) } : {}) } : x));
    try { await post(`tasks/${t.id}`, body); if (ok) notify({ id: "task-edit", tone: "success", title: ok, message: t.title, timeout: 2200 }); router.refresh(); }
    catch (e) { setRows(before); notify({ id: "task-edit", tone: "error", title: "Not saved", message: msg(e) }); }
  }
  async function bulk(set: Record<string, unknown>, ok: (n: number) => string, undo?: () => void) {
    setBusy(true);
    try { const r = await post<{ changed: number; failed: { title: string | null; error: string }[] }>("work/tasks/bulk", { ids: selectedList, set });
      notify({ id: "bulk", tone: r.failed.length ? "error" : "success", title: r.failed.length ? `${r.changed} changed, ${r.failed.length} not` : ok(r.changed), message: r.failed[0] ? `${r.failed[0].title ?? "A task"}: ${r.failed[0].error}` : undefined,
        timeout: undo ? 6500 : 3500, ...(undo && r.changed ? { action: { label: "Undo", run: undo } } : {}) });
      setSelected(new Set()); router.refresh(); }
    catch (e) { notify({ id: "bulk", tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); }
  }
  const review = home.review, incoming = asks.filter((a) => a.incoming), outgoing = asks.filter((a) => !a.incoming);
  const needs = review.length + waitingOnMe.length + incoming.length;
  // Folded by default when there is more than a couple of things and the person has their own open work to see.
  const showNeeds = needsOpen ?? (savedNeeds ? savedNeeds === "open" : needs <= 2 || !count("open"));
  const row = (t: Task) => <Row key={t.id} t={t} today={today} me={me} selected={selected.has(t.id)} leaving={leaving.has(t.id)} done={justDone.has(t.id)} renaming={renaming === t.id}
    onTick={() => void tick(t)} onSelect={(e) => toggle(t.id, e.shiftKey)} onRename={(on) => setRenaming(on ? t.id : null)}
    onSaveTitle={(title) => { setRenaming(null); if (title.trim() && title.trim() !== t.title) void save(t, { title: title.trim() }, "Renamed"); }}
    onDue={(day) => void save(t, { dueOn: day }, day ? `Due ${day === today ? "today" : shortDay(day)}` : "No due date")} onMove={() => setMoving([t.id])} />;

  return <section className={css.listPanel} aria-label="My tasks" data-selecting={selecting || selected.size ? "" : undefined} data-lens={lens}>
    {/* WORK-UX (owner, 29 Oct 2026, report #1): whose list, which tasks and Select are one row at the top of the list. */}
    <div className={css.listHead}>
    <div className={css.lenses} role="group" aria-label="Which list">{LENSES.map((l) => <button key={l.key} type="button" aria-pressed={lens === l.key} title={l.tip} onClick={() => look(l.key)}>{l.label}<span>{lensCount(l.key, all, me)}</span></button>)}</div>
    <div className={css.listTop} data-phone-filter="">
      {/* UX-SIMPLE (28 Oct 2026): one "Show" pick instead of five status tabs beside the four lenses (agreed in MY-TASKS.md). */}
      <Select label="Which tasks" size="sm" variant="ghost" value={filter} onChange={(v) => { if (v) choose(v as Filter); }} placement="bottom-start"
        options={FILTERS.map((f) => ({ value: f.key, label: `${f.label} · ${count(f.key)}` }))} renderValue={(o) => <><span className={css.showLabel}>Show</span><span>{o.label}</span></>} />
      <button type="button" className={css.toolBtn} aria-pressed={selecting} aria-label="Select tasks" title="Select tasks" onClick={() => { setSelecting(!selecting); if (selecting) setSelected(new Set()); }}><SquareCheck size={14} aria-hidden="true" /><span>Select</span></button>
    </div>
    </div>
    <div className={css.scroller}>
      {needs ? <div className={css.needs} aria-label="Needs you" role="region" data-folded={showNeeds ? undefined : ""}>
        <h3><button type="button" className={css.needsHead} aria-expanded={showNeeds} onClick={() => foldNeeds(!showNeeds)}><ChevronDown size={13} aria-hidden="true" />Needs you
          {showNeeds ? null : <span className={css.needsSum}>{[incoming.length ? plural(incoming.length, "request") : "", review.length ? `${review.length} to review` : "", waitingOnMe.length ? `${waitingOnMe.length} waiting on you` : ""].filter(Boolean).join(" · ")}</span>}<small>{needs}</small></button></h3>
        {showNeeds ? <>
        {incoming.length ? <ul className={css.rows} aria-label="Requests for you">{incoming.slice(0, 4).map((a) => <AskRow key={a.id} ask={a} />)}</ul> : null}
        {/* TASKS-4B: who finished it (photo), how it went against the deadline and how long it has waited; the rest in the queue. */}
        {review.length ? <ul className={css.rows} aria-label="Ready for you to accept">{review.slice(0, 3).map((t) => { const when = timingOf(t.dueAt, t.doneAt), wait = waitedFor(t.doneAt, now); return <li key={t.id} className={css.need}>
          <Avatar name={t.assigneeName ?? "Someone"} id={t.assigneeId ?? undefined} photoAt={t.assigneePhotoAt} size={28} />
          <span className={css.needMain}><Link href={`/tasks/${t.id}`}>{t.title}</Link><small>{first(t.assigneeName) || "Someone"} finished it{when ? ` ${when.words}` : ""}{wait ? ` · waiting ${wait}` : ""}</small></span>
          <span className={css.needActions}><AcceptButton task={t} label={t.leaderWork ? "Accept" : "Review"} /></span></li>; })}</ul> : null}
        {review.length > 3 ? <Link href="/tasks?view=reviews" className={css.more}>Review all {review.length} waiting for you, oldest first</Link> : null}
        {waitingOnMe.length ? <ul className={css.rows} aria-label="Waiting on you">{waitingOnMe.slice(0, allNeeds ? undefined : Math.max(2, 5 - incoming.length - review.length)).map((t) => <li key={t.id} className={css.need}>
          <Hourglass size={18} aria-hidden="true" style={{ color: "var(--theme-warning)" }} />
          <span className={css.needMain}><Link href={`/tasks/${t.id}`}>{t.title}</Link><small>Waiting on your {t.needs.join(" and ")} · {t.assigneeName ?? "nobody yet"}</small></span><span /></li>)}</ul> : null}
        {!allNeeds && waitingOnMe.length > Math.max(2, 5 - incoming.length - review.length) ? <button type="button" className={css.more} onClick={() => setAllNeeds(true)}>Show {waitingOnMe.length - Math.max(2, 5 - incoming.length - review.length)} more waiting on you</button> : null}
        </> : null}
      </div> : null}
      {outgoing.length ? <div className={css.needs} data-quiet="" aria-label="Your requests" role="region" data-folded={showNeeds ? undefined : ""}>
        <h3><button type="button" className={css.needsHead} aria-expanded={showNeeds} onClick={() => foldNeeds(!showNeeds)}><ChevronDown size={13} aria-hidden="true" />Waiting for an answer<small>{outgoing.length}</small></button></h3>
        {showNeeds ? <ul className={css.rows}>{outgoing.slice(0, 3).map((a) => <AskRow key={a.id} ask={a} />)}</ul> : null}
      </div> : null}
      {SHOWN[filter].map((k) => {
        const s = SECTIONS.find((x) => x.key === k)!; const items = sections[k]; if (!items.length) return null;
        const open = !folded.has(k); const list = k === "done" ? items.slice(0, doneShown) : items;
        return <section key={k} className={css.section} aria-label={s.label}>
          <button type="button" className={css.sectionHead} data-tone={s.tone} aria-expanded={open} onClick={() => setFolded((f) => { const n = new Set(f); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>
            <ChevronDown size={13} aria-hidden="true" />{s.label}<small>{items.length}</small></button>
          {open ? <ul className={css.rows}>{list.map(row)}</ul> : null}
          {open && k === "done" && items.length > doneShown ? <button type="button" className={css.more} onClick={() => setDoneShown(doneShown + 40)}>Show {Math.min(40, items.length - doneShown)} more</button> : null}
        </section>;
      })}
      {!count(filter) ? <p className={css.empty}><Check size={22} aria-hidden="true" /><b>{lens === "assigned" && filter === "open" ? "Nobody has given you anything open" : lens === "created" && filter === "open" ? "Nothing open that you created"
        : lens === "reviewing" && filter === "open" ? "Nothing of anyone else’s for you to review" : filter === "done" ? "Nothing finished yet" : filter === "blocked" ? "Nothing is blocking you" : "All clear"}</b>
        {filter === "done" ? "Tick the circle on a task when it is done. Your reviewer then accepts it." : filter === "blocked" ? "When a task waits on someone, add what it waits on: its owner is told, and you hear when it clears."
          : <ByDevice keys="Press N to add a task, or claim one from the pool." touch="Tap New task to add a task, or claim one from the pool." />}</p> : null}
      <p className={css.footLinks}><Link href="/tasks?view=deleted"><Trash2 size={12} aria-hidden="true" />Recently deleted</Link></p>
    </div>
    {selectedList.length ? <div className={css.bulk} role="toolbar" aria-label="Selected tasks">
      <b>{selectedList.length} selected</b>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void bulk({ status: "done" }, (n) => `${n} done`)}><Check size={13} aria-hidden="true" />Mark done</button>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => setMoving(selectedList)}><FolderKanban size={13} aria-hidden="true" />Move to project</button>
      <Pop label="Due day for the selected tasks" up button={(toggle, expanded) => <button type="button" className={styles.btn} disabled={busy} onClick={toggle} aria-expanded={expanded}><CalendarDays size={13} aria-hidden="true" />Due day</button>}>
        {(close) => <DueMenu today={today} current={null} close={close} onPick={(day) => void bulk({ dueOn: day }, (n) => day ? `${n} due ${day === today ? "today" : shortDay(day)}` : `${n} without a date`)} />}</Pop>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => setGiving(selectedList)}><UserRound size={13} aria-hidden="true" />Give to…</button>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => setDeleting(selectedList)}><Trash2 size={13} aria-hidden="true" />Delete</button>
      <span className={css.spacer} />
      <button type="button" className={css.iconBtn} onClick={() => setSelected(new Set())} aria-label="Clear the selection" title="Clear"><X size={15} aria-hidden="true" /></button>
    </div> : null}
    {moving ? <MoveDialog ids={moving} current={moving.length === 1 ? rows.find((r) => r.id === moving[0])?.projectId ?? null : null} onClose={() => setMoving(null)} onMoved={() => setSelected(new Set())} /> : null}
    {giving ? <GiveMany ids={giving} onClose={() => setGiving(null)} onDone={() => setSelected(new Set())} /> : null}
    {deleting ? deleting.length === 1 ? <DeleteDialog taskId={deleting[0]} goTo={null} onClose={() => { setDeleting(null); setSelected(new Set()); }} />
      : <Modal title={`Delete ${deleting.length} tasks?`} sub="Their subtasks go with them; tasks waiting on them stop waiting. You can restore each for 30 days from Recently deleted." onClose={() => setDeleting(null)}
        foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setDeleting(null)}>Keep them</button>
          <button type="button" className={`${styles.btn} ${css.danger}`} disabled={busy} onClick={async () => {
            const ids = deleting; setDeleting(null);
            await bulk({ delete: true }, (n) => `${n} deleted · restore them for 30 days from Recently deleted`,
              () => { void Promise.all(ids.map((id) => post(`tasks/${id}/restore`, {}).catch(() => null))).then(() => router.refresh()); });
          }}><Trash2 size={14} aria-hidden="true" />Delete {deleting.length}</button></div>}>
        <ul className={css.connected}>{deleting.map((id) => rows.find((r) => r.id === id)).filter((t): t is Task => !!t).slice(0, 8).map((t) => <li key={t.id}><Trash2 size={15} aria-hidden="true" /><span><b>{t.title}</b>{t.subtasks ? <small>{plural(t.subtasks, "subtask")} {t.subtasks === 1 ? "goes" : "go"} with it</small> : null}</span></li>)}</ul>
      </Modal> : null}
  </section>;
}

/** The week at a glance beside the list: done, accepted and waiting, hours, a bar per day, the streak (no points). */
export function WeekCard({ home }: { home: Home }) {
  const zone = useOrgZone();
  const s = home.summary; if (!s) return null;
  const days = Array.from({ length: 7 }, (_, i) => addDays(home.week, i));
  const dayOf = (iso: string | null) => iso ? zoneDay(zone, iso) : null;
  const per = days.map((d) => home.rows.filter((t) => FINISHED.includes(t.status) && dayOf(t.doneAt) === d).length);
  const peak = Math.max(1, ...per);
  const quiet = !s.weekDone && !s.minutes;
  return <section className={css.card} aria-label="This week">
    <div className={css.cardHead}><h3>This week</h3><Link href="/tasks/outcomes">My outcomes</Link></div>
    <div className={css.cardBody}>
      {quiet ? <p className={css.line}>Nothing finished yet this week. Your first done task starts the chart.</p> : <><div className={css.nums}>
        <span className={css.num}><b>{s.weekDone}</b><span>done</span></span>
        <span className={css.num} data-tone="value" title="Finished work someone accepted this week"><b>{s.weekAccepted}</b><span>accepted</span></span>
        <span className={css.num}><b>{(s.minutes / 60).toFixed(s.minutes % 60 ? 1 : 0)}</b><span>hours logged</span></span>
      </div>
      <div className={css.days} role="img" aria-label={`Tasks done each day this week: ${per.join(", ")}`}>
        {days.map((d, i) => <span key={d} className={css.dayBar} data-today={d === home.today ? "" : undefined} data-zero={per[i] ? undefined : ""} title={`${shortDay(d)}: ${per[i]} done`}>
          <i style={{ height: `${Math.max(per[i] ? 14 : 4, Math.round((per[i] / peak) * 40))}px` }} /><span>{shortDay(d).slice(0, 1)}</span></span>)}
      </div></>}
      {s.pendingTasks ? <p className={css.line}><Hourglass size={13} aria-hidden="true" /><span><b>{plural(s.pendingTasks, "task")}</b> waiting for acceptance</span></p> : null}
      <p className={css.line}><span className={css.streak} aria-hidden="true">●</span>{s.streak ? <span><b>{s.streak}-week</b> streak · keep it going</span> : <span>Finish one task this week to start a streak</span>}</p>
      {s.proposals ? <p className={css.line}><Undo2 size={13} aria-hidden="true" style={{ transform: "scaleX(-1)" }} /><span>{plural(s.proposals, "time entry", "time entries")} proposed from your work. <Link href="/tasks/outcomes">Confirm</Link></span></p> : null}
    </div>
  </section>;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
