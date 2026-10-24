"use client";
// TASKS-4A views: Table. A database-style grid: sortable columns (click a heading; again to reverse), and cells that
// edit in place (status, who, due, priority, project) through one shared editor that opens under the cell. Changes go
// through the same routes as the task page (giving someone a task outside your reach still becomes a request).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
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

type Field = "status" | "who" | "due" | "priority" | "project";
type Col = { key: string; label: string; sort?: Sort; field?: Field; width?: string };
const COLS: Col[] = [
  { key: "title", label: "Task", sort: "title" }, { key: "status", label: "Status", field: "status" }, { key: "who", label: "Who", field: "who" },
  { key: "due", label: "Due", sort: "due", field: "due" }, { key: "priority", label: "Priority", sort: "priority", field: "priority" }, { key: "project", label: "Project", field: "project" },
  { key: "kind", label: "Kind" }, { key: "updated", label: "Changed", sort: "updated" },
];
const STATUS_OPTIONS: Option[] = [{ value: "open", label: "To do" }, { value: "in_progress", label: "Doing" }, { value: "blocked", label: "Blocked" }, { value: "done", label: "Done" }];
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const ago = (iso: string | null, now: number) => { if (!iso) return ""; const m = Math.round((now - Date.parse(iso)) / 60000); return m < 60 ? `${Math.max(1, m)} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };

export function TableView({ rows, today, me, sort, onSort, now }: { rows: Task[]; today: string; me: string | null; sort: Sort; onSort: (s: Sort) => void; now: number }) {
  const router = useRouter();
  const asking = useArmedTask();
  const [dir, setDir] = useState<1 | -1>(1);
  const [patch, setPatch] = useState<Record<string, Partial<Task>>>({});
  const [edit, setEdit] = useState<{ id: string; field: Field } | null>(null), [q, setQ] = useState(""), [active, setActive] = useState(0);
  const anchor = useRef<HTMLElement | null>(null), listRef = useRef<HTMLUListElement>(null), search = useRef<HTMLInputElement>(null);
  const { data: options } = useWorkOptions(!!edit && (edit.field === "who" || edit.field === "project"));
  const list = useMemo(() => sortRows(rows.map((t) => patch[t.id] ? { ...t, ...patch[t.id] } : t), sort, dir), [rows, patch, sort, dir]);
  const task = edit ? list.find((t) => t.id === edit.id) ?? null : null;
  const choices: Option[] = !edit ? [] : edit.field === "status" ? STATUS_OPTIONS : edit.field === "priority" ? PRIORITIES.map((p) => ({ value: p.value, label: p.label }))
    : edit.field === "who" ? personOptions(options?.people ?? [], options?.me) : edit.field === "project" ? [{ value: "", label: "No project" }, ...(options?.projects ?? []).map((p) => ({ value: p.id, label: p.name, detail: p.clientName ?? undefined }))] : [];
  const found = q ? choices.filter((o) => `${o.label} ${typeof o.detail === "string" ? o.detail : ""}`.toLowerCase().includes(q.toLowerCase())) : choices;
  const open = (e: React.MouseEvent<HTMLElement>, id: string, field: Field) => { anchor.current = e.currentTarget; setQ(""); setActive(0); setEdit({ id, field }); };
  async function save(t: Task, field: Field, value: string | null, label?: string) {
    setEdit(null); anchor.current?.focus();
    const change: Partial<Task> = field === "status" ? { status: value ?? "open" } : field === "priority" ? { priority: value as Task["priority"] } : field === "due" ? { dueOn: value, dueAt: value ? `${value}T12:30:00Z` : null }
      : field === "project" ? { projectId: value, projectName: value ? label ?? null : null } : { assigneeId: value, assigneeName: label ?? null, assigneePhotoAt: null };
    setPatch((p) => ({ ...p, [t.id]: { ...p[t.id], ...change } }));
    try {
      if (field === "status") { const r = await post<{ weekDone?: number; streak?: number }>(`tasks/${t.id}/move`, { status: value }); if (value === "done") celebrate(r, t.title); }
      else if (field === "who") { const r = await post<{ asked: { to: string | null } | null }>(`work/tasks/${t.id}/assign`, { personId: value }); if (r.asked) { notify({ id: "table-ask", tone: "info", title: `Asked ${String(label ?? "them").split(" ")[0]}`, message: "It stays as it is until they accept." }); setPatch((p) => ({ ...p, [t.id]: { ...p[t.id], assigneeId: t.assigneeId, assigneeName: t.assigneeName, assigneePhotoAt: t.assigneePhotoAt } })); } }
      else await post(`tasks/${t.id}`, field === "due" ? { dueOn: value } : field === "priority" ? { priority: value } : { projectId: value });
      router.refresh();
    } catch (e) { setPatch((p) => { const n = { ...p }; delete n[t.id]; return n; }); notify({ id: "table-edit", tone: "error", title: "Not changed", message: msg(e) }); }
  }
  const head = (c: Col) => {
    const on = c.sort === sort;
    return <th key={c.key} scope="col" aria-sort={on ? (dir === 1 ? "ascending" : "descending") : undefined} data-col={c.key}>
      {c.sort ? <button type="button" className={css.th} onClick={() => { if (on) setDir((d) => (d === 1 ? -1 : 1)); else { setDir(1); onSort(c.sort!); } }}>{c.label}{on ? dir === 1 ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" /> : null}</button> : c.label}
    </th>;
  };
  const cell = (t: Task, field: Field, body: React.ReactNode, label: string) => <button type="button" className={css.cell} aria-haspopup="listbox" aria-expanded={edit?.id === t.id && edit.field === field}
    aria-label={`${label} for “${t.title}”: change`} disabled={!me} onClick={(e) => open(e, t.id, field)}>{body}</button>;
  return <div className={css.tableWrap} data-grow="">
    <table className={css.table}>
      <thead><tr><th scope="col" className={css.checkCol}><span className={css.srOnly}>Done</span></th>{COLS.map(head)}</tr></thead>
      <tbody>{list.map((t) => {
        const st = STATUS[t.status] ?? STATUS.unknown, due = dueText(t, today), finished = isFinished(t), pr = PRIORITIES.find((p) => p.value === t.priority);
        return <tr key={t.id} data-done={finished ? "" : undefined}>
          <td className={css.checkCol}><button type="button" className={asking === t.id ? `${css.check} ${armedClass}` : css.check} data-done={finished ? "" : undefined} data-armed={asking === t.id ? "" : undefined} disabled={finished || !me}
            aria-label={finished ? `${t.title}: ${st.label}` : tickProps(t.title, asking === t.id).label} title={finished ? st.label : tickProps(t.title, asking === t.id).tip}
            onClick={() => tickDone(t.id, t.title, () => void save(t, "status", "done"))}><Check size={12} strokeWidth={3} aria-hidden="true" /></button></td>
          <th scope="row" className={css.titleCell}><Link href={`/tasks/${t.id}`} title={t.title}>{t.title}</Link></th>
          <td>{cell(t, "status", <span className={css.pill} data-tone={st.tone}>{st.label}</span>, "Status")}</td>
          <td>{cell(t, "who", t.assigneeName ? <><Avatar name={t.assigneeName} id={t.assigneeId ?? undefined} photoAt={t.assigneePhotoAt} size={22} /><span>{t.assigneeId === me ? "Me" : t.assigneeName.split(" ")[0]}</span></> : <span className={css.muted}>{t.poolScope ? "Pool" : "Nobody"}</span>, "Who")}</td>
          <td>{cell(t, "due", due ? <span className={css.when} data-late={due.late ? "" : undefined}>{due.text}</span> : <span className={css.muted}>No date</span>, "Due")}</td>
          <td>{cell(t, "priority", pr ? <span className={css.prio} data-p={pr.value}><pr.Icon size={13} aria-hidden="true" />{pr.label}</span> : null, "Priority")}</td>
          <td>{cell(t, "project", t.projectName ? <span className={css.ellipsis}>{t.projectName}</span> : <span className={css.muted}>None</span>, "Project")}</td>
          <td><span className={css.kindCell}><CategoryIcon category={t.category} size={13} />{t.categoryLabel ?? "—"}</span></td>
          <td className={css.muted}>{ago(t.updatedAt ?? t.createdAt, now)}</td>
        </tr>;
      })}</tbody>
    </table>
    <Popover open={!!edit && !!task} onClose={() => setEdit(null)} anchor={anchor} label={edit ? `Change ${edit.field}` : "Change"} role="none" placement="bottom-start" sheet={edit?.field === "due"}
      focus={edit?.field === "who" || edit?.field === "project" ? search : edit?.field === "due" ? "first" : listRef}>
      {task && edit?.field === "due" ? <Calendar value={{ date: task.dueOn, time: null }} today={today} onChange={(v) => void save(task, "due", v.date)} onClear={() => void save(task, "due", null)} label="Due" />
        : task && edit ? <div className={css.editor}>
          {edit.field === "who" || edit.field === "project" ? <input ref={search} className={css.editorSearch} value={q} placeholder={edit.field === "who" ? "Search people" : "Search projects"} aria-label={edit.field === "who" ? "Search people" : "Search projects"}
            role="combobox" aria-expanded="true" aria-controls="table-editor" aria-activedescendant={found[active] ? `table-editor-${active}` : undefined}
            onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={(e) => { if (listKeys(e, found.length, active, setActive)) return; if (e.key === "Enter" && found[active]) { e.preventDefault(); void save(task, edit.field, found[active].value || null, found[active].label); } }} />
            : null}
          {(edit.field === "who" || edit.field === "project") && !options ? <p className={css.muted} style={{ padding: 12 }}>Loading…</p>
            : <OptionList id="table-editor" label={`Change ${edit.field}`} options={found.slice(0, 60)} active={active} onActive={setActive}
              chosen={(edit.field === "status" ? task.status : edit.field === "priority" ? task.priority : edit.field === "who" ? task.assigneeId : task.projectId ?? "") as string}
              onChoose={(o) => void save(task, edit.field, o.value || null, o.label)}
              focusRef={edit.field === "status" || edit.field === "priority" ? listRef : undefined}
              onKeyDown={edit.field === "status" || edit.field === "priority" ? (e) => { if (listKeys(e, found.length, active, setActive)) return; if (e.key === "Enter" && found[active]) { e.preventDefault(); void save(task, edit.field, found[active].value, found[active].label); } } : undefined} />}
        </div> : null}
    </Popover>
  </div>;
}
