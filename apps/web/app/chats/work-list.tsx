"use client";
// CHAT-WORK: /tasks, /projects and /steps in a conversation. The list is the asker's own (only they see it, under the
// latest message, until they close it or leave the chat); "Share in chat" posts it as a message everyone in the chat
// sees, tasks as their live cards.
import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, BellRing, Bot, FolderKanban, ListTodo, Send, Workflow, X } from "lucide-react";
import { send } from "./net";
import { useOrgZone } from "../org-code";
import { dueLabel } from "./task-card";
import type { Attachment } from "./types";
import type { WorkKind } from "./commands";
import css from "./work.module.css";

type Scope = { kind: string; name: string; pod: string | null; people: number };
type WorkTask = { id: string; title: string; status: string; statusLabel: string; priority: string | null; assigneeId: string | null; assigneeName: string | null; assigneeAgent: boolean; dueOn: string | null; late: boolean | null; projectName: string | null };
type WorkProject = { id: string; name: string; kind: string; status: string; pod: string | null; ownerName: string | null; open: number; late: number; nextDue: string | null };
type WorkStep = { id: string; title: string; state: string; dueOn: string | null; late: boolean | null; blocked: boolean; runId: string; run: string; process: string; personName: string | null; href: string; followed: boolean };
export type WorkData = { scope: Scope; kind: WorkKind; more: boolean; tasks?: WorkTask[]; projects?: WorkProject[]; steps?: WorkStep[] };
export type WorkResult = { key: string; kind: WorkKind; data?: WorkData; error?: string };

const TITLE: Record<WorkKind, string> = { tasks: "Open tasks", projects: "Projects", steps: "Flow steps open" };
const ICON = { tasks: ListTodo, projects: FolderKanban, steps: Workflow };
const STEP_STATE: Record<string, string> = { open: "To do", in_progress: "Doing", in_review: "In review" };
const where = (s: Scope) => s.kind === "direct" ? "between the two of you" : s.kind === "pod" ? `in the pod ${s.name}` : s.kind === "team" ? `in the team ${s.name}` : `of ${s.name}’s people`;

/** J4: the team's open tasks by person, whoever has the most late work first (late ones first within each person). */
function byPerson(tasks: WorkTask[]): [string, WorkTask[]][] {
  const groups = new Map<string, WorkTask[]>();
  for (const t of tasks) { const k = t.assigneeName ?? "Nobody yet"; groups.set(k, [...(groups.get(k) ?? []), t]); }
  const late = (l: WorkTask[]) => l.filter((t) => t.late).length;
  return [...groups.entries()].sort((a, b) => late(b[1]) - late(a[1]) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

export function WorkList({ result, channelId, onClose, onShare }: { result: WorkResult; channelId: string; onClose: () => void; onShare: (text: string, attachments: Attachment[]) => void }) {
  const zone = useOrgZone();
  const [following, setFollowing] = useState<"" | "busy" | "on" | string>("");
  const runs = [...new Set((result.data?.steps ?? []).map((s) => s.runId))];
  const allFollowed = following === "on" || (runs.length > 0 && (result.data?.steps ?? []).every((s) => s.followed));
  async function follow() {
    setFollowing("busy");
    try { for (const r of runs) await send(`chats/flow-runs/${r}/follow`, { channelId, on: true }); setFollowing("on"); }
    catch (e) { setFollowing((e as Error).message); }
  }
  const Icon = ICON[result.kind], d = result.data;
  const rows = d ? d[d.kind]?.length ?? 0 : 0;
  function share() {
    if (!d) return;
    const head = `${TITLE[d.kind]} ${where(d.scope)}: ${rows}${d.more ? "+" : ""}`;
    if (d.kind === "tasks") onShare(head, (d.tasks ?? []).slice(0, 5).map((t) => ({ task: t.id, name: t.title.slice(0, 300) })));
    else if (d.kind === "projects") onShare([head, ...(d.projects ?? []).slice(0, 12).map((p) => `• ${p.name}: ${p.open} open${p.late ? `, ${p.late} late` : ""}`)].join("\n"), []);
    else onShare([head, ...(d.steps ?? []).slice(0, 12).map((s) => `• ${s.title} (${s.run})${s.personName ? ` · ${s.personName}` : ""}${s.blocked ? " · blocked" : ""}`)].join("\n"), []);
  }
  return <section className={css.work} aria-label={TITLE[result.kind]} data-work-list={result.kind}>
    <header>
      <Icon size={16} aria-hidden="true" />
      <span><b>{TITLE[result.kind]}{d ? ` ${where(d.scope)}` : ""}</b><small>Only you can see this{d ? ` · ${rows}${d.more ? "+" : ""}` : ""}</small></span>
      <button type="button" className={css.close} onClick={onClose} aria-label="Close this list"><X size={15} aria-hidden="true" /></button>
    </header>
    {result.error ? <p className={css.error} role="alert">{result.error}</p>
      : !d ? <p className={css.empty} role="status">Looking…</p>
      : !rows ? <p className={css.empty}>{d.kind === "tasks" ? "Nothing open. Everyone here is clear." : d.kind === "projects" ? "No live projects for this group’s people." : "No Flow steps open for this group’s people."}</p>
      : <ul className={css.rows}>
        {d.kind === "tasks" ? byPerson(d.tasks!).flatMap(([who, list]) => [
          <li key={`g:${who}`} className={css.group}>{list[0].assigneeAgent ? <Bot size={12} aria-label="AI employee" /> : null}{who} · {list.length}{list.some((t) => t.late) ? <span>{list.filter((t) => t.late).length} late</span> : null}</li>,
          ...list.map((t) => <li key={t.id} data-status={t.status}>
            <em data-status={t.status}>{t.statusLabel}</em>
            <Link href={`/tasks/${t.id}`}>{t.title}</Link>
            <small>{t.projectName ?? "No project"}</small>
            {t.dueOn ? <small data-late={t.late || undefined}>{dueLabel(t.dueOn, zone)}</small> : null}
          </li>)])
        : d.kind === "projects" ? d.projects!.map((p) => <li key={p.id}>
          <em data-late={p.late ? "" : undefined}>{p.late ? `${p.late} late` : `${p.open} open`}</em>
          <Link href={`/tasks/projects/${p.id}`}>{p.name}</Link>
          <small>{p.ownerName ?? "No owner"}{p.pod ? ` · ${p.pod}` : ""}{p.late ? ` · ${p.open} open` : ""}</small>
          {p.nextDue ? <small>Next {dueLabel(p.nextDue, zone).replace(/^Due /, "")}</small> : null}
        </li>)
        : d.steps!.map((s) => <li key={s.id} data-status={s.blocked ? "blocked" : s.state}>
          <em data-status={s.blocked ? "blocked" : s.state}>{s.blocked ? <><AlertTriangle size={11} aria-hidden="true" />Blocked</> : STEP_STATE[s.state] ?? s.state}</em>
          <Link href={s.href}>{s.title}</Link>
          <small>{s.run}{s.personName ? ` · ${s.personName}` : ""}</small>
          {s.dueOn ? <small data-late={s.late || undefined}>{dueLabel(s.dueOn, zone)}</small> : null}
        </li>)}
      </ul>}
    {following && !["busy", "on"].includes(following) ? <p className={css.error} role="alert">{following}</p> : null}
    {d && rows ? <footer>
      {d.more ? <small>Showing the first {rows}.</small> : <span />}
      <span className={css.footActions}>
        {d.kind === "steps" ? <button type="button" className={css.share} disabled={allFollowed || following === "busy"} onClick={() => void follow()} data-follow-runs="">
          <BellRing size={14} aria-hidden="true" />{allFollowed ? "Their updates post here" : runs.length > 1 ? "Post these runs’ updates here" : "Post this run’s updates here"}</button> : null}
        <button type="button" className={css.share} onClick={share}><Send size={14} aria-hidden="true" />Share in chat</button>
      </span>
    </footer> : null}
  </section>;
}
