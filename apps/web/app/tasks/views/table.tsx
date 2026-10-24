"use client";
// TASKS-4A views: Table. A database-style grid: sortable columns (click a heading; again to reverse), and cells that
// edit in place (status, who, due, priority, project) through one shared editor that opens under the cell. Changes go
// through the same routes as the task page (giving someone a task outside your reach still becomes a request).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, Check } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { Avatar } from "../../ui";
import { Calendar, OptionList, Popover, listKeys, personOptions, type Option } from "../../kit";
import { useWorkOptions } from "../../create";
import { celebrate } from "../client";
import { STATUS, dueText } from "../parts";
import { CategoryIcon } from "../kinds";
import { PRIORITIES } from "../priority";
import type { Task } from "../types";
import { isFinished, sortRows, type Sort } from "./model";
import css from "./views.module.css";
import { armedClass, tickDone, tickProps, useArmedTask } from "../confirm-done";

type Field = "title" | "status" | "who" | "due" | "priority" | "project";
type Cell = { id: string; field: Field };
const FIELDS: Field[] = ["title", "status", "who", "due", "priority", "project"];
type Col = { key: string; label: string; sort?: Sort; field?: Field; width?: string };
const COLS: Col[] = [
  { key: "title", label: "Task", sort: "title" }, { key: "status", label: "Status", field: "status" }, { key: "who", label: "Who", field: "who" },
  { key: "due", label: "Due", sort: "due", field: "due" }, { key: "priority", label: "Priority", sort: "priority", field: "priority" }, { key: "project", label: "Project", field: "project" },
  { key: "kind", label: "Kind" }, { key: "updated", label: "Changed", sort: "updated" },
];
const STATUS_OPTIONS: Option[] = [{ value: "open", label: "To do" }, { value: "in_progress", label: "Doing" }, { value: "blocked", label: "Blocked" }, { value: "done", label: "Done" }];
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const ago = (iso: string | null, now: number) => { if (!iso) return ""; const m = Math.round((now - Date.parse(iso)) / 60000); return m < 60 ? `${Math.max(1, m)} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };

export function TableView({ rows, today, me, sort, onSort, now, onChange, newRow }: { rows: Task[]; today: string; me: string | null; sort: Sort; onSort: (s: Sort) => void; now: number; onChange: (id: string, change: Partial<Task>) => void; newRow?: React.ReactNode }) {
  const router = useRouter();
  const asking = useArmedTask();
  const [dir, setDir] = useState<1 | -1>(1);
  const [focused, setFocused] = useState<Cell | null>(null), focusTo = useRef<Cell | "new" | null>(null);
  const [title, setTitle] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [draft, setDraft] = useState<{ value: string | null; label?: string } | null>(null);
  const inFlight = useRef(false), revision = useRef(0), wrap = useRef<HTMLDivElement>(null);
  const [edit, setEdit] = useState<{ id: string; field: Field } | null>(null), [q, setQ] = useState(""), [active, setActive] = useState(0);
  const anchor = useRef<HTMLElement | null>(null), listRef = useRef<HTMLUListElement>(null), search = useRef<HTMLInputElement>(null);
  const { data: options } = useWorkOptions(!!edit && (edit.field === "who" || edit.field === "project"));
  const list = useMemo(() => sortRows(rows, sort, dir), [rows, sort, dir]);
  const task = edit ? list.find((t) => t.id === edit.id) ?? null : null;
  const choices: Option[] = !edit ? [] : edit.field === "status" ? STATUS_OPTIONS : edit.field === "priority" ? PRIORITIES.map((p) => ({ value: p.value, label: p.label }))
    : edit.field === "who" ? personOptions(options?.people ?? [], options?.me) : edit.field === "project" ? [{ value: "", label: "No project" }, ...(options?.projects ?? []).map((p) => ({ value: p.id, label: p.name, detail: p.clientName ?? undefined }))] : [];
  const found = q ? choices.filter((o) => `${o.label} ${typeof o.detail === "string" ? o.detail : ""}`.toLowerCase().includes(q.toLowerCase())) : choices;
  useEffect(() => {
    const to = focusTo.current;
    if (!to || edit || busy) return;
    focusTo.current = null;
    const target = to === "new" ? wrap.current?.querySelector<HTMLInputElement>('input[aria-label="New task"]')
      : wrap.current?.querySelector<HTMLElement>(`[data-task-cell="${CSS.escape(`${to.id}:${to.field}`)}"]`);
    (target ?? wrap.current?.querySelector<HTMLElement>('[data-task-cell], input[aria-label="New task"]'))?.focus();
  }, [focused, edit, busy, rows]);
  const go = (to: Cell | "new") => { focusTo.current = to; setFocused(to === "new" ? null : to); };
  const neighbor = (from: Cell, step: number, vertical = false): Cell | "new" | null => {
    const index = list.findIndex((t) => t.id === from.id) * FIELDS.length + FIELDS.indexOf(from.field) + step * (vertical ? FIELDS.length : 1);
    if (index < 0) return null;
    if (index >= list.length * FIELDS.length) return newRow ? "new" : null;
    return { id: list[Math.floor(index / FIELDS.length)].id, field: FIELDS[index % FIELDS.length] };
  };
  const close = () => { if (inFlight.current) return; setEdit(null); setError(""); if (edit) go(edit); };
  const open = (el: HTMLElement, t: Task, field: Field, text = t.title) => {
    if (inFlight.current || !me) return;
    anchor.current = el; revision.current++; setTitle(text); setDraft(null); setError(""); setQ("");
    const value = field === "status" ? t.status : field === "priority" ? t.priority : field === "who" ? t.assigneeId : t.projectId;
    setActive(Math.max(0, (field === "status" ? STATUS_OPTIONS : field === "priority" ? PRIORITIES : []).findIndex((o) => o.value === value)));
    setEdit({ id: t.id, field });
  };
  const keys = (e: React.KeyboardEvent<HTMLElement>, t: Task, field: Field) => {
    const from = { id: t.id, field };
    if (e.key === "Tab" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      const to = neighbor(from, e.shiftKey || e.key === "ArrowUp" ? -1 : 1, e.key !== "Tab");
      if (to) { e.preventDefault(); go(to); } return;
    }
    const typed = field === "title" && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === "Enter" || e.key === "F2" || typed) { e.preventDefault(); e.stopPropagation(); open(e.currentTarget, t, field, typed ? e.key : t.title); }
  };
  const focusProps = (t: Task, field: Field) => ({
    "data-task-cell": `${t.id}:${field}`, tabIndex: (focused && list.some((r) => r.id === focused.id) ? focused.id === t.id && focused.field === field : list[0]?.id === t.id && field === "title") ? 0 : -1,
    onFocus: () => setFocused({ id: t.id, field }), onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => keys(e, t, field),
  });
  async function save(t: Task, field: Field, value: string | null, label?: string, after?: Cell | "new" | null) {
    if (inFlight.current || !me) return;
    if (field === "title" && !value?.trim()) { setError("Add a title before saving."); return; }
    if (field === "title") value = value!.trim();
    const submittedRevision = revision.current;
    const destination = after ?? (field === "title" ? neighbor({ id: t.id, field }, 1, true) : null) ?? { id: t.id, field };
    inFlight.current = true; setBusy(true); setError(""); setDraft({ value, label });
    let change: Partial<Task> = field === "title" ? { title: value! } : field === "status" ? { status: value ?? "open" } : field === "priority" ? { priority: value as Task["priority"] } : field === "due" ? { dueOn: value, dueAt: value ? `${value}T12:30:00Z` : null }
      : field === "project" ? { projectId: value, projectName: value ? label ?? null : null } : { assigneeId: value, assigneeName: label ?? null, assigneePhotoAt: null };
    try {
      if (field === "status") { const r = await post<{ weekDone?: number; streak?: number }>(`tasks/${t.id}/move`, { status: value }); if (value === "done") celebrate(r, t.title); }
      else if (field === "who") { const r = await post<{ asked: { to: string | null } | null }>(`work/tasks/${t.id}/assign`, { personId: value }); if (r.asked) { notify({ id: "table-ask", tone: "info", title: `Asked ${String(label ?? "them").split(" ")[0]}`, message: "It stays as it is until they accept." }); change = {}; } }
      else await post(`tasks/${t.id}`, field === "title" ? { title: value } : field === "due" ? { dueOn: value } : field === "priority" ? { priority: value } : { projectId: value });
      onChange(t.id, change);
      if (revision.current === submittedRevision) { setEdit(null); go(destination); }
      router.refresh();
    } catch (e) { if (revision.current === submittedRevision) setError(msg(e)); if (!edit) notify({ id: "table-edit", tone: "error", title: "Not changed", message: msg(e) }); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const feedback = task && edit ? <div className={css.saveFeedback} aria-live="polite">
    {busy ? "Saving…" : error ? <><span role="alert">{error}</span><button type="button" className={css.cell} onClick={() => void save(task, edit.field, edit.field === "title" ? title : draft!.value, draft?.label)}>Retry</button></> : null}
  </div> : null;
  const head = (c: Col) => {
    const on = c.sort === sort;
    return <th key={c.key} scope="col" aria-sort={on ? (dir === 1 ? "ascending" : "descending") : undefined} data-col={c.key}>
      {c.sort ? <button type="button" className={css.th} onClick={() => { if (on) setDir((d) => (d === 1 ? -1 : 1)); else { setDir(1); onSort(c.sort!); } }}>{c.label}{on ? dir === 1 ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" /> : null}</button> : c.label}
    </th>;
  };
  const cell = (t: Task, field: Field, body: React.ReactNode, label: string) => <button type="button" className={css.cell} {...focusProps(t, field)} aria-haspopup="listbox" aria-expanded={edit?.id === t.id && edit.field === field}
    aria-label={`${label} for “${t.title}”: change`} disabled={!me} onClick={(e) => open(e.currentTarget, t, field)}>{body}</button>;
  return <div ref={wrap} className={css.tableWrap} data-grow="">
    <table className={css.table}>
      <thead><tr><th scope="col" className={css.checkCol}><span className={css.srOnly}>Done</span></th>{COLS.map(head)}</tr></thead>
      <tbody>{list.map((t) => {
        const st = STATUS[t.status] ?? STATUS.unknown, due = dueText(t, today), finished = isFinished(t), pr = PRIORITIES.find((p) => p.value === t.priority);
        return <tr key={t.id} data-done={finished ? "" : undefined}>
          <td className={css.checkCol}><button type="button" className={asking === t.id ? `${css.check} ${armedClass}` : css.check} data-done={finished ? "" : undefined} data-armed={asking === t.id ? "" : undefined} disabled={finished || !me}
            aria-label={finished ? `${t.title}: ${st.label}` : tickProps(t.title, asking === t.id).label} title={finished ? st.label : tickProps(t.title, asking === t.id).tip}
            onClick={() => tickDone(t.id, t.title, () => void save(t, "status", "done"))}><Check size={12} strokeWidth={3} aria-hidden="true" /></button></td>
          <th scope="row" className={css.titleCell}><div className={css.titleEntry}>
            {edit?.id === t.id && edit.field === "title" ? <div><input autoFocus className={css.titleInput} aria-label="Task title" value={title} maxLength={500}
              onChange={(e) => { revision.current++; setTitle(e.target.value); setError(""); }} onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Escape") { e.preventDefault(); close(); }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); void save(t, "title", title, undefined, e.key === "Tab" ? neighbor({ id: t.id, field: "title" }, e.shiftKey ? -1 : 1) : undefined); }
              }} />{feedback}</div>
              : <button type="button" className={css.cell} {...focusProps(t, "title")} disabled={!me} aria-label={`Title for “${t.title}”: change`} onClick={(e) => open(e.currentTarget, t, "title")}>{t.title}</button>}
            <Link className={css.taskLink} href={`/tasks/${t.id}`} aria-label={`Open task: ${t.title}`} title="Open task"><ArrowUpRight size={16} aria-hidden="true" /></Link>
          </div></th>
          <td>{cell(t, "status", <span className={css.pill} data-tone={st.tone}>{st.label}</span>, "Status")}</td>
          <td>{cell(t, "who", t.assigneeName ? <><Avatar name={t.assigneeName} id={t.assigneeId ?? undefined} photoAt={t.assigneePhotoAt} size={22} /><span>{t.assigneeId === me ? "Me" : t.assigneeName.split(" ")[0]}</span></> : <span className={css.muted}>{t.poolScope ? "Pool" : "Nobody"}</span>, "Who")}</td>
          <td>{cell(t, "due", due ? <span className={css.when} data-late={due.late ? "" : undefined}>{due.text}</span> : <span className={css.muted}>No date</span>, "Due")}</td>
          <td>{cell(t, "priority", pr ? <span className={css.prio} data-p={pr.value}><pr.Icon size={13} aria-hidden="true" />{pr.label}</span> : null, "Priority")}</td>
          <td>{cell(t, "project", t.projectName ? <span className={css.ellipsis}>{t.projectName}</span> : <span className={css.muted}>None</span>, "Project")}</td>
          <td><span className={css.kindCell}><CategoryIcon category={t.category} size={13} />{t.categoryLabel ?? "—"}</span></td>
          <td className={css.muted}>{ago(t.updatedAt ?? t.createdAt, now)}</td>
        </tr>;
      })}{newRow ? <tr><td colSpan={COLS.length + 1}><div className={css.newRow} onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement && !e.target.hasAttribute("aria-controls") && (e.key === "ArrowUp" || e.key === "Tab" && e.shiftKey) && list.length) {
          e.preventDefault(); go({ id: list[list.length - 1].id, field: e.key === "Tab" ? "project" : "title" });
        }
      }}>{newRow}</div></td></tr> : null}</tbody>
    </table>
    <Popover open={!!edit && edit.field !== "title" && !!task} onClose={close} anchor={anchor} label={edit ? `Change ${edit.field}` : "Change"} role="none" placement="bottom-start" sheet={edit?.field === "due"}
      focus={edit?.field === "who" || edit?.field === "project" ? search : edit?.field === "due" ? "first" : listRef}>
      <div onKeyDown={(e) => { if (e.key === "Tab" && edit && !inFlight.current) { const to = neighbor(edit, e.shiftKey ? -1 : 1); if (to) { e.preventDefault(); setEdit(null); go(to); } } }}>
      {task && edit?.field === "due" ? <Calendar value={{ date: draft ? draft.value : task.dueOn, time: null }} today={today} onChange={(v) => void save(task, "due", v.date)} onClear={() => void save(task, "due", null)} label="Due" />
        : task && edit ? <div className={css.editor}>
          {edit.field === "who" || edit.field === "project" ? <input ref={search} className={css.editorSearch} value={q} placeholder={edit.field === "who" ? "Search people" : "Search projects"} aria-label={edit.field === "who" ? "Search people" : "Search projects"}
            role="combobox" aria-expanded="true" aria-controls="table-editor" aria-activedescendant={found[active] ? `table-editor-${active}` : undefined}
            onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={(e) => { if (listKeys(e, found.length, active, setActive)) return; if (e.key === "Enter" && found[active]) { e.preventDefault(); void save(task, edit.field, found[active].value || null, found[active].label); } }} />
            : null}
          {(edit.field === "who" || edit.field === "project") && !options ? <p className={css.muted} style={{ padding: 12 }}>Loading…</p>
            : <OptionList id="table-editor" label={`Change ${edit.field}`} options={found.slice(0, 60)} active={active} onActive={setActive}
              chosen={(draft ? draft.value ?? "" : (edit.field === "status" ? task.status : edit.field === "priority" ? task.priority : edit.field === "who" ? task.assigneeId : task.projectId ?? "")) as string}
              onChoose={(o) => void save(task, edit.field, o.value || null, o.label)}
              focusRef={edit.field === "status" || edit.field === "priority" ? listRef : undefined}
              onKeyDown={edit.field === "status" || edit.field === "priority" ? (e) => { if (listKeys(e, found.length, active, setActive)) return; if (e.key === "Enter" && found[active]) { e.preventDefault(); void save(task, edit.field, found[active].value, found[active].label); } } : undefined} />}
        </div> : null}
      {feedback}</div>
    </Popover>
  </div>;
}
