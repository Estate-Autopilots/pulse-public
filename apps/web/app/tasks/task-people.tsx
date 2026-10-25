"use client";
// TASKS-3: who does a task, who works on it with them, where it lives and its tags, changed in place. The owner found
// "adding people, tagging things" broken: Give to… listed only the people one may assign and failed on anyone else,
// people could only be invited, and tasks could not be tagged at all. Each of these is now one small dialog or an
// inline control, and someone outside the viewer's reach gets a request instead of an error.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { FolderKanban, Hash, Plus, UserPlus, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { PersonPicker, ProjectPicker, useWorkOptions, type Person } from "../create";
import { Modal, post } from "../records";
import { Avatar, styles } from "../ui";
import { PeoplePopover, type PopPerson } from "../kit/people-popover";
import { DatePicker } from "../kit";
import css from "./work3.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const first = (name: string | null | undefined) => String(name ?? "Someone").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
type Assigned = { assigned: boolean; asked: { id: string; to: string | null } | null; assigneeName: string | null; unchanged?: boolean };

/** Say what happened after giving a task: theirs now, or asked. */
export function saidAssigned(r: Assigned, name: string) {
  if (r.unchanged) return;
  if (r.asked) notify({ id: "assign", tone: "success", title: `Asked ${first(r.asked.to ?? name)} to take it`, message: "It stays with you until they accept. You hear their answer.", timeout: 4200 });
  else notify({ id: "assign", tone: "success", title: `${first(r.assigneeName ?? name)} does it now`, message: "They are told in Pulse, on the phone and on the desktop.", timeout: 3500 });
}

/** Who does it: everyone is listed; people outside the viewer's reach are marked "Ask" and get a request. */
export function AssignDialog({ taskId, current, onClose }: { taskId: string; current: string | null; onClose: () => void }) {
  const router = useRouter(); const { data } = useWorkOptions(); const [busy, setBusy] = useState(false);
  async function pick(p: Person | null) {
    if (!p || busy) return; setBusy(true);
    try { const r = await post<Assigned>(`tasks/${taskId}/give`, { personId: p.id }); saidAssigned(r, p.name); onClose(); router.refresh(); }
    catch (e) { notify({ id: "assign", tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); }
  }
  return <Modal title="Who does it?" sub="People inside your reach get it at once. Anyone else gets a request to accept or decline." onClose={onClose}>
    <div className={css.dialogBody}>
      {data ? <PersonPicker people={data.people.filter((p) => p.id !== current)} value={null} onChange={pick} me={data.me} label="Who does it" showAsk autoFocus /> : <p className={styles.muted}>Loading people…</p>}
    </div>
  </Modal>;
}

/** Add people to work on a task with its doer: added at once (and told) when the viewer may assign them, else invited. */
export function PeopleDialog({ taskId, exclude, onClose }: { taskId: string; exclude: string[]; onClose: () => void }) {
  const router = useRouter(); const { data } = useWorkOptions();
  const [picked, setPicked] = useState<Person[]>([]), [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await post<{ added: number; invited: number }>(`work/tasks/${taskId}/people`, { add: picked.map((p) => p.id) });
      notify({ id: "people", tone: "success", title: [r.added ? `${r.added} added` : "", r.invited ? `${r.invited} invited` : ""].filter(Boolean).join(" · ") || "No change",
        message: r.invited ? "Invited people accept or decline; the rest can work on it now." : "They can work on it now and were told.", timeout: 3500 });
      onClose(); router.refresh();
    } catch (e) { notify({ id: "people", tone: "error", title: "Not added", message: msg(e) }); } finally { setBusy(false); }
  }
  const left = (data?.people ?? []).filter((p) => !exclude.includes(p.id) && !picked.some((x) => x.id === p.id));
  return <Modal title="Add people to this task" sub="They work on it with whoever does it, and hear when it moves." onClose={onClose}
    foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !picked.length} onClick={save}>{picked.length ? `Add ${picked.length}` : "Add"}</button></div>}>
    <div className={css.dialogBody}>
      {picked.length ? <div className={css.pickedRow}>{picked.map((p) => <span key={p.id} className={css.picked}><Avatar name={p.name} id={p.id} photoAt={p.photoAt ?? null} size={20} />{first(p.name)}{p.canAssign === false ? <em>invite</em> : null}
        <button type="button" aria-label={`Remove ${p.name}`} onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}><X size={11} aria-hidden="true" /></button></span>)}</div> : null}
      {data ? <PersonPicker people={left} value={null} onChange={(p) => p && setPicked([...picked, p])} me={data.me} label="Add a person" showAsk autoFocus /> : <p className={styles.muted}>Loading people…</p>}
    </div>
  </Modal>;
}

/** Move one or several tasks into a project (or out of every project). */
export function MoveDialog({ ids, current, title, onClose, onMoved }: { ids: string[]; current: string | null; title?: string; onClose: () => void; onMoved?: () => void }) {
  const router = useRouter(); const { data } = useWorkOptions(); const [busy, setBusy] = useState(false);
  async function move(projectId: string | null) {
    if (busy) return; setBusy(true);
    try {
      const r = await post<{ changed: number; failed: { title: string | null; error: string }[] }>("work/tasks/bulk", { ids, set: { projectId } });
      const name = data?.projects.find((p) => p.id === projectId)?.name ?? null;
      notify({ id: "move", tone: r.failed.length ? "error" : "success", title: r.failed.length ? `${r.changed} moved, ${r.failed.length} not` : name ? `Moved to ${name}` : "Out of the project",
        message: r.failed[0] ? `${r.failed[0].title ?? "A task"}: ${r.failed[0].error}` : ids.length > 1 ? `${r.changed} tasks` : undefined, timeout: 3500 });
      onMoved?.(); onClose(); router.refresh();
    } catch (e) { notify({ id: "move", tone: "error", title: "Not moved", message: msg(e) }); } finally { setBusy(false); }
  }
  return <Modal title={title ?? (ids.length > 1 ? `Move ${ids.length} tasks to a project` : "Move to a project")} sub="Internal projects and client fulfilment, recent first." onClose={onClose}>
    <div className={css.dialogBody}>
      {data ? <ProjectPicker projects={data.projects} value={current} onChange={(id) => void move(id)} label="Project to move to" autoFocus /> : <p className={styles.muted}>Loading projects…</p>}
    </div>
  </Modal>;
}

/** Tags on a task: chips, a small box to add one (with the tags already in use), × to remove. */
export function TagEditor({ taskId, tags, canEdit }: { taskId: string; tags: string[]; canEdit: boolean }) {
  const router = useRouter();
  const [list, setList] = useState(tags), [base, setBase] = useState(tags), [adding, setAdding] = useState(false), [text, setText] = useState(""), [known, setKnown] = useState<string[] | null>(null);
  if (base !== tags) { setBase(tags); setList(tags); }
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (adding && !known) fetch("/api/v0/work/tags").then((r) => r.ok ? r.json() : { rows: [] }).then((d) => setKnown(d.rows.map((x: { tag: string }) => x.tag))).catch(() => setKnown([])); }, [adding, known]);
  const clean = (t: string) => t.trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_&-]/gu, "").slice(0, 40);
  const hints = useMemo(() => { const q = clean(text); return (known ?? []).filter((k) => !list.includes(k) && (!q || k.includes(q))).slice(0, 6); }, [known, text, list]);
  async function save(next: string[]) {
    const before = list; setList(next);
    try { await post(`tasks/${taskId}`, { tags: next }); router.refresh(); }
    catch (e) { setList(before); notify({ id: "tags", tone: "error", title: "Tags not saved", message: msg(e) }); }
  }
  function add(e?: FormEvent) { e?.preventDefault(); const t = clean(text); if (t && !list.includes(t)) void save([...list, t]); setText(""); input.current?.focus(); }
  const key = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Escape") { setAdding(false); setText(""); } else if (e.key === "Backspace" && !text && list.length) void save(list.slice(0, -1)); else if (e.key === "," || e.key === " ") { e.preventDefault(); add(); } };
  return <span className={css.tags} aria-label="Tags">
    {list.map((t) => <span key={t} className={css.tag}><Hash size={11} aria-hidden="true" />{t}{canEdit ? <button type="button" aria-label={`Remove tag ${t}`} onClick={() => void save(list.filter((x) => x !== t))}><X size={11} aria-hidden="true" /></button> : null}</span>)}
    {canEdit ? adding ? <form className={css.tagForm} onSubmit={add}>
      <Hash size={12} aria-hidden="true" /><input ref={input} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={key} onBlur={() => { if (!text.trim()) setAdding(false); }} placeholder="tag" aria-label="New tag" autoFocus maxLength={40} list={`tags-${taskId}`} />
      <datalist id={`tags-${taskId}`}>{hints.map((h) => <option key={h} value={h} />)}</datalist>
    </form> : <button type="button" className={css.tagAdd} onClick={() => setAdding(true)} aria-label="Add a tag"><Plus size={12} aria-hidden="true" />Tag</button> : null}
  </span>;
}

/** The hero's people: who does it (click to change), who works on it with them, and + to add someone. */
export function HeroPeople({ taskId, doer, me, canEdit, members, reviewer }: { taskId: string; doer: { id: string | null; name: string | null; photoAt: string | null }; me: string | null; canEdit: boolean;
  members: { id: string; name: string; role: string; photoAt: string | null }[]; reviewer: { id: string | null; name: string | null } }) {
  // Owner workbench (21 Oct 2026): both open a people list right at the chip; one click gives the task or adds the
  // person (the add list stays open for more). No dialog, no second dropdown, no Save.
  const router = useRouter(); const { data } = useWorkOptions();
  const [open, setOpen] = useState<null | "assign" | "people">(null), [added, setAdded] = useState<string[]>([]);
  const assignAt = useRef<HTMLButtonElement>(null), addAt = useRef<HTMLButtonElement>(null);
  const team = members.filter((m) => m.role === "collaborator");
  const people = (data?.people ?? []) as PopPerson[];
  const taken = [doer.id, reviewer.id, ...team.map((m) => m.id), ...added].filter((x): x is string => !!x);
  async function give(p: PopPerson) {
    try { const r = await post<Assigned>(`tasks/${taskId}/give`, { personId: p.id }); saidAssigned(r, p.name); router.refresh(); }
    catch (e) { notify({ id: "assign", tone: "error", title: "Not changed", message: msg(e) }); }
  }
  async function add(p: PopPerson) {
    setAdded((a) => [...a, p.id]);
    try {
      const r = await post<{ added: number; invited: number }>(`work/tasks/${taskId}/people`, { add: [p.id] });
      notify({ id: "people", tone: "success", title: r.invited ? `${first(p.name)} invited` : `${first(p.name)} added`, message: r.invited ? "They accept or decline." : "They can work on it now and were told.", timeout: 2600 });
      router.refresh();
    } catch (e) { setAdded((a) => a.filter((x) => x !== p.id)); notify({ id: "people", tone: "error", title: "Not added", message: msg(e) }); }
  }
  const doing = doer.name ? <><Avatar name={doer.name} id={doer.id ?? undefined} photoAt={doer.photoAt} size={22} status /><span>{doer.id === me ? "You" : doer.name}</span><small>doing it</small></> : <small>Nobody has it yet</small>;
  return <>
    <li>{canEdit ? <button ref={assignAt} type="button" className={css.factBtn} onClick={() => setOpen(open === "assign" ? null : "assign")} aria-expanded={open === "assign"} title="Change who does it" aria-label={`Who does it: ${doer.name ?? "nobody"}. Change`}>{doing}</button> : doing}</li>
    {team.length ? <li className={css.with}><span className={css.stack}>{team.slice(0, 4).map((m) => <span key={m.id} title={m.name}><Avatar name={m.name} id={m.id} photoAt={m.photoAt} size={22} /></span>)}</span>
      <small>{team.length === 1 ? `with ${first(team[0].name)}` : `with ${team.length} people`}</small></li> : null}
    {canEdit ? <li><button ref={addAt} type="button" className={css.addPeople} onClick={() => setOpen(open === "people" ? null : "people")} aria-expanded={open === "people"} aria-label="Add people to this task" title="Add people"><UserPlus size={14} aria-hidden="true" /><span>Add people</span></button></li> : null}
    <PeoplePopover open={open === "assign"} onClose={() => setOpen(null)} anchor={assignAt} people={people.filter((p) => p.id !== doer.id)} onPick={(p) => void give(p)} label="Who does it" me={me} />
    <PeoplePopover open={open === "people"} onClose={() => setOpen(null)} anchor={addAt} people={people} chosen={taken} keepOpen onPick={(p) => void add(p)} label="Add people to this task" me={me} />
  </>;
}

/** Owner workbench (21 Oct 2026): the due date chip is the control: a click opens the date picker right there and the
 *  choice saves at once (it used to sit behind the task's "…" menu). */
export function DueEdit({ taskId, dueOn, today, children }: { taskId: string; dueOn: string | null; today: string; children: ReactNode }) {
  const router = useRouter();
  async function save(day: string | null) {
    try { await post(`tasks/${taskId}`, { dueOn: day }); notify({ id: "due", tone: "success", title: day ? `Due ${day === today ? "today" : day}` : "No due date", timeout: 2200 }); router.refresh(); }
    catch (e) { notify({ id: "due", tone: "error", title: "Not changed", message: msg(e) }); }
  }
  // QA-1024 (R037): the due chip carries its own clock icon, so the calendar icon goes once a date is set, and the
  // control may wrap (work3 .dueTrigger) instead of being cut at the properties panel edge (390 px phone, 1440 side panel).
  return <DatePicker value={{ date: dueOn, time: null }} onChange={(v) => void save(v.date)} today={today} label="Due date" placeholder="No due date" variant="ghost" size="sm" renderValue={() => children} highlight={false} icon={dueOn ? <></> : undefined} className={css.dueTrigger} />;
}

/** The project chip as a control: click to move the task to another project. */
export function ProjectMove({ taskId, projectId, children }: { taskId: string; projectId: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={css.chipBtn} data-empty={children ? undefined : ""} onClick={() => setOpen(true)} title={projectId ? "Move to another project" : "Put it in a project"}>{children ?? <><FolderKanban size={12} aria-hidden="true" />Project</>}</button>
    {open ? <MoveDialog ids={[taskId]} current={projectId} onClose={() => setOpen(false)} /> : null}
  </>;
}

/** People on the task, listed with a way to take someone off (for editors, and for oneself). */
export function MemberList({ taskId, members, me, canEdit }: { taskId: string; members: { id: string; name: string; role: string; photoAt: string | null }[]; me: string | null; canEdit: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function remove(id: string) {
    setBusy(true);
    try { await post(`work/tasks/${taskId}/people`, { remove: [id] }); router.refresh(); }
    catch (e) { notify({ id: "people", tone: "error", title: "Not removed", message: msg(e) }); } finally { setBusy(false); }
  }
  if (!members.length) return null;
  return <ul className={css.memberList}>{members.map((m) => <li key={m.id}><Avatar name={m.name} id={m.id} photoAt={m.photoAt} size={26} status /><span>{m.name}<small>{m.role === "collaborator" ? "Works on it" : "Following"}</small></span>
    {canEdit || m.id === me ? <button type="button" className={styles.iconBtn} disabled={busy} aria-label={`Take ${m.name} off this task`} title="Take off this task" onClick={() => void remove(m.id)}><X size={13} aria-hidden="true" /></button> : null}</li>)}</ul>;
}
