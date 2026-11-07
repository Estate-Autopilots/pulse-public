"use client";
// TASKS-3: Work → Projects as a tree with progress. Categories hold their projects; projects placed under a client
// package sit beneath it; any project opens in place to its open tasks (loaded when opened), each with a tick. Every
// bar is finished · in progress · open, with what is late or blocked beside it.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronRight, FolderKanban, Hourglass, Plus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { openCreate } from "../create";
import { post } from "../records";
import { Avatar } from "../ui";
import { KindChip, kindOf } from "../work-kind";
import { PROJECT_ICONS } from "./chips";
import { shortDay } from "./parts";
import type { Task } from "./types";
import f from "./focus.module.css";
import css from "./projects-tree.module.css";
import { armedClass, tickDone, tickProps, useArmedTask } from "./confirm-done";

export type TreeRow = { id: string; name: string; kind: string; status: string; pod: string | null; dueOn: string | null; setUp: boolean; clientName: string | null; ownerId: string | null; ownerName: string | null;
  ownerPhotoAt: string | null; total: number; finished: number; open: number; overdue: number; blocked: number; doing?: number; nextDue: string | null; members: number; mine: boolean;
  partOf?: { id: string; name: string } | null; includes?: number; category?: string | null; categoryLabel?: string | null; color?: string | null; icon?: string | null };
type Category = { key: string; label: string; icon: string; color: string };
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const pct = (a: number, b: number) => b ? Math.round((100 * a) / b) : 0;

/** Finished, in progress and still open as one bar; late and blocked counts beside it. */
export function Progress({ total, finished, doing = 0, overdue, blocked, label }: { total: number; finished: number; doing?: number; overdue: number; blocked: number; label: string }) {
  const p = pct(finished, total);
  return <span className={css.progress} role="img" aria-label={`${label}: ${p}% done, ${finished} of ${total} tasks${overdue ? `, ${overdue} late` : ""}${blocked ? `, ${blocked} blocked` : ""}`}>
    <span className={css.bar}><i data-part="done" style={{ width: `${p}%` }} /><i data-part="doing" style={{ width: `${pct(doing, total)}%` }} /></span>
    <span className={css.pct}>{total ? `${p}%` : "—"}</span>
  </span>;
}

function Tasks({ projectId }: { projectId: string }) {
  const router = useRouter();
  const asking = useArmedTask();
  const [rows, setRows] = useState<Task[] | null>(null), [done, setDone] = useState<Set<string>>(new Set());
  // EST-1018 (UI sweep): a column that fails to load is an error with Try again, never "No open tasks".
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const read = (column: string, size: number) => fetch(`/api/v0/tasks?project=${projectId}&size=${size}&column=${column}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).then((d) => d.rows as Task[]);
    Promise.all([read("doing", 30), read("blocked", 30), read("todo", 60)]).then((parts) => { setFailed(false); setRows(parts.flat()); })
      .catch(() => { setFailed(true); setRows([]); });
  }, [projectId, attempt]);
  async function tick(t: Task) {
    setDone((s) => new Set(s).add(t.id));
    try { await post(`tasks/${t.id}/move`, { status: "done" }); notify({ id: "task-done", tone: "success", title: `Done: ${t.title}`, timeout: 2500 }); router.refresh(); }
    catch (e) { setDone((s) => { const n = new Set(s); n.delete(t.id); return n; }); notify({ id: "task-done", tone: "error", title: "Not marked done", message: msg(e) }); }
  }
  if (rows === null) return <p className={css.loading} aria-busy="true">Loading its tasks…</p>;
  if (failed) return <p className={css.failed} role="alert"><AlertTriangle size={14} aria-hidden="true" />Its tasks didn’t load.
    <button type="button" onClick={() => { setRows(null); setAttempt((n) => n + 1); }}>Try again</button></p>;
  return <ul className={css.tasks}>
    {rows.slice(0, 40).map((t) => <li key={t.id} data-done={done.has(t.id) ? "" : undefined}>
      <button type="button" className={asking === t.id ? `${css.tick} ${armedClass}` : css.tick} data-armed={asking === t.id ? "" : undefined} onClick={() => tickDone(t.id, t.title, () => void tick(t))}
        disabled={done.has(t.id)} aria-label={tickProps(t.title, asking === t.id).label} title={tickProps(t.title, asking === t.id).tip}><Check size={11} strokeWidth={3} aria-hidden="true" /></button>
      <Link href={`/tasks/${t.id}`} className={css.taskTitle} title={t.title}>{t.title}</Link>
      <span className={css.taskMeta}>{t.status === "in_progress" ? <em data-tone="doing">Doing</em> : t.status === "blocked" ? <em data-tone="late">Blocked</em> : null}{t.dueOn ? <em>{shortDay(t.dueOn)}</em> : null}</span>
      {t.assigneeName ? <span title={t.assigneeName}><Avatar name={t.assigneeName} id={t.assigneeId ?? undefined} photoAt={t.assigneePhotoAt} size={20} /></span> : <span className={css.nobody}>Open</span>}
    </li>)}
    {!rows.length ? <li className={css.none}>No open tasks.</li> : null}
    <li className={css.addRow}><button type="button" onClick={() => openCreate({ kind: "task", projectId })}><Plus size={13} aria-hidden="true" />Add a task</button>
      <Link href={`/tasks/projects/${projectId}`}>Open the project<ChevronRight size={13} aria-hidden="true" /></Link></li>
  </ul>;
}

function Node({ p, kids, today, labels, depth }: { p: TreeRow; kids: TreeRow[]; today: string; labels?: { fulfilmentChip?: string }; depth: number }) {
  const [open, setOpen] = useState(false);
  const Icon = PROJECT_ICONS[p.icon ?? ""] ?? FolderKanban;
  return <li className={css.node} data-depth={depth}>
    <div className={css.row} data-open={open ? "" : undefined}>
      <button type="button" className={css.toggle} aria-expanded={open} aria-label={`${open ? "Close" : "Open"} ${p.name}`} onClick={() => setOpen(!open)}><ChevronRight size={15} aria-hidden="true" /></button>
      <span className={`${css.icon} ${f.proj}`} data-color={p.color ?? undefined} aria-hidden="true"><Icon size={16} /></span>
      <span className={css.main}>
        <span className={css.nameLine}><Link href={`/tasks/projects/${p.id}`} className={css.name}>{p.name}</Link>{p.kind === "fulfilment" ? <KindChip kind={kindOf(p.kind)} short label={labels?.fulfilmentChip} /> : null}
          {p.kind === "fulfilment" && !p.setUp ? <em className={css.flag}>Not set up</em> : null}</span>
        <span className={css.facts}>
          {p.clientName && p.kind === "fulfilment" ? <span>for {p.clientName}</span> : p.pod ? <span>{p.pod}</span> : null}
          {p.total ? <span>{p.finished}/{p.total} done</span> : <span>No tasks yet</span>}
          {p.overdue ? <span data-tone="late"><AlertTriangle size={11} aria-hidden="true" />{p.overdue} late</span> : null}
          {p.blocked ? <span data-tone="warn"><Hourglass size={11} aria-hidden="true" />{p.blocked} blocked</span> : null}
          {p.nextDue ? <span>next {p.nextDue === today ? "today" : shortDay(p.nextDue)}</span> : p.dueOn ? <span>due {shortDay(p.dueOn)}</span> : null}
          {kids.length ? <span>{kids.length} under it</span> : null}
        </span>
      </span>
      <Progress total={p.total} finished={p.finished} doing={p.doing} overdue={p.overdue} blocked={p.blocked} label={p.name} />
      <span className={css.owner}>{p.ownerName ? <span title={`Owner: ${p.ownerName}`}><Avatar name={p.ownerName} id={p.ownerId ?? undefined} photoAt={p.ownerPhotoAt} size={26} /></span> : <span className={css.nobody} title="Nobody owns it yet">—</span>}</span>
    </div>
    {open ? <div className={css.inside}>
      {kids.length ? <ul className={css.children}>{kids.map((c) => <Node key={c.id} p={c} kids={[]} today={today} labels={labels} depth={depth + 1} />)}</ul> : null}
      <Tasks projectId={p.id} />
    </div> : null}
  </li>;
}

export function ProjectsTree({ rows, categories, today, labels }: { rows: TreeRow[]; categories: Category[]; today: string; labels?: { fulfilmentChip?: string } }) {
  const [shut, setShut] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const ids = new Set(rows.map((r) => r.id));
    const under = new Map<string, TreeRow[]>();
    for (const r of rows) if (r.partOf && ids.has(r.partOf.id)) under.set(r.partOf.id, [...(under.get(r.partOf.id) ?? []), r]);
    const roots = rows.filter((r) => !(r.partOf && ids.has(r.partOf.id)));
    const byCat = new Map<string, TreeRow[]>();
    for (const r of roots) { const k = r.category ?? (r.kind === "fulfilment" ? "client" : "internal"); byCat.set(k, [...(byCat.get(k) ?? []), r]); }
    const order = [...categories.map((c) => c.key), ...[...byCat.keys()].filter((k) => !categories.some((c) => c.key === k))];
    return order.filter((k) => byCat.has(k)).map((k) => {
      const list = byCat.get(k)!; const all = [...list, ...list.flatMap((r) => under.get(r.id) ?? [])];
      const sum = (f: (r: TreeRow) => number) => all.reduce((n, r) => n + f(r), 0);
      const c = categories.find((x) => x.key === k);
      return { key: k, label: c?.label ?? list[0].categoryLabel ?? (k === "client" ? "Client delivery" : "Internal"), icon: c?.icon ?? "folder", color: c?.color, list, under,
        total: sum((r) => r.total), finished: sum((r) => r.finished), doing: sum((r) => r.doing ?? 0), overdue: sum((r) => r.overdue), blocked: sum((r) => r.blocked) };
    });
  }, [rows, categories]);
  return <ul className={css.tree} aria-label="Projects by category">{groups.map((g) => {
    const Icon = PROJECT_ICONS[g.icon] ?? FolderKanban; const open = !shut.has(g.key);
    return <li key={g.key} className={css.group}>
      <button type="button" className={css.groupHead} aria-expanded={open} onClick={() => setShut((s) => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}>
        <ChevronRight size={15} aria-hidden="true" className={css.chev} /><span className={`${css.groupIcon} ${f.proj}`} data-color={g.color} aria-hidden="true"><Icon size={15} /></span>
        <b>{g.label}</b><small>{g.list.length} {g.list.length === 1 ? "project" : "projects"}</small>
        <Progress total={g.total} finished={g.finished} doing={g.doing} overdue={g.overdue} blocked={g.blocked} label={g.label} />
      </button>
      {open ? <ul className={css.nodes}>{g.list.map((p) => <Node key={p.id} p={p} kids={g.under.get(p.id) ?? []} today={today} labels={labels} depth={0} />)}</ul> : null}
    </li>;
  })}</ul>;
}
