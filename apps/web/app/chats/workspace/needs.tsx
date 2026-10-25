"use client";
// CHAT-SHELL (J1, J12): what needs the person, on the chat's home. Tasks given to them (done in one tap, with undo),
// their process steps, the chats that mention them and, for leaders, the projects that are late or blocked with a
// one-tap nudge to the project's owner. Each opens beside the chat. Read once when the home opens; nothing is counted
// for the person by these clicks. FEATURES-1024 (J1, J8): missed calls come first, with Call back; calling back (or a
// later answered call in that conversation) clears one.
import { useEffect, useState } from "react";
import { AlarmClock, AtSign, Check, CircleCheck, FolderKanban, ListChecks, Phone, PhoneMissed, Send, Video } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { openInPanel } from "./tabs";
import { startCall } from "../../calls/call-host";
import { missedCalls, type CallEntry, type RecentCall } from "../../lib/call-log.mjs";
import type { Channel, ChatData, Member } from "../types";
import css from "./workspace.module.css";

type Task = { id: string; title: string; status: string; projectName: string | null; dueOn: string | null; assigneeId: string | null; createdBy?: string | null; priority?: string | null };
type Step = { id: string; title: string; run?: string | null; process?: string | null; href: string; due_on?: string | null; due?: string | null; dueOn?: string | null };
type Project = { id: string; name: string; overdue: number; blocked: number; ownerId: string | null; ownerName: string | null; open: number };
const OPEN = new Set(["open", "in_progress", "blocked"]);
// E2E-4P (owner check): each read gives up after 12 s and is tried three times (1 s, 3 s apart); a card whose read still
// fails shows nothing rather than an endless skeleton.
const once = async <T,>(path: string): Promise<T | null> => { try { const r = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(12000) }); return r.ok ? await r.json() as T : null; } catch { return null; } };
const read = async <T,>(path: string): Promise<T | null> => { for (const wait of [0, 1000, 3000]) { if (wait) await new Promise((r) => setTimeout(r, wait)); const d = await once<T>(path); if (d) return d; } return null; };
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
function dueWords(due: string | null | undefined) {
  // CHAT-V4: a step's due may come as a full time ("2026-10-26T10:00:00Z"): the day is its first ten letters (it read "Invalid Date").
  const d = due && /^\d{4}-\d{2}-\d{2}/.test(due) ? due.slice(0, 10) : null;
  if (!d) return null; const t = today();
  if (d < t) return { text: "Late", late: true };
  if (d === t) return { text: "Today", late: false };
  return { text: new Date(`${d}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }), late: false };
}

export function NeedsYou({ data, mentions, onChoose, onNudge }: { data: ChatData; mentions: Channel[]; onChoose: (id: string) => void; onNudge: (p: Member, draft: string) => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null), [steps, setSteps] = useState<Step[] | null>(null), [late, setLate] = useState<Project[] | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const [missed, setMissed] = useState<(CallEntry & { count: number })[] | null>(null), [calledBack, setCalledBack] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void read<{ rows?: Task[] }>("/api/v0/tasks/home").then((d) => { if (live) setTasks((d?.rows ?? []).filter((t) => OPEN.has(t.status) && t.assigneeId === data.viewer)
      .sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") || Number(b.priority === "urgent") - Number(a.priority === "urgent")).slice(0, 5)); });
    void read<{ recent?: RecentCall[] }>("/api/v0/calls").then((d) => { if (live) setMissed(d ? missedCalls(d.recent, data.viewer) : []); });
    void read<{ steps?: Step[] }>("/api/v1/flow/my-steps").then((d) => { if (live) setSteps((d?.steps ?? []).slice(0, 4)); });
    if (data.canLead) void read<{ rows?: Project[] }>("/api/v0/work/projects").then((d) => { if (live) setLate((d?.rows ?? []).filter((p) => p.overdue > 0 || p.blocked > 0).sort((a, b) => b.overdue + b.blocked - a.overdue - a.blocked).slice(0, 5)); });
    return () => { live = false; };
  }, [data.viewer, data.canLead]);

  // One tap marks a task done at once; the server catches up, and Undo puts it back as it was.
  async function finish(t: Task) {
    setDone((d) => ({ ...d, [t.id]: t.status }));
    const move = (status: string) => fetch(`/api/v0/tasks/${t.id}/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) })
      .then(async (r) => { if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That did not go through."); });
    try {
      await move("done");
      notify({ id: `done-${t.id}`, tone: "success", title: `Done: ${t.title.slice(0, 60)}`, message: "Whoever gave it is told.", timeout: 6000,
        action: { label: "Undo", run: () => { setDone((d) => { const n = { ...d }; delete n[t.id]; return n; }); void move(t.status).catch(() => {}); } } });
    } catch (e) {
      setDone((d) => { const n = { ...d }; delete n[t.id]; return n; });
      notify({ id: `done-${t.id}`, tone: "error", title: "Not marked done", message: `${(e as Error).message} Open the task to finish it there.`, timeout: 5000 });
    }
  }

  const openTasks = tasks?.filter((t) => !done[t.id]) ?? null;
  const missedNow = missed?.filter((m) => !calledBack.includes(m.channelId)) ?? null;
  const callTime = (iso: string) => { const d = new Date(iso), t = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}, ${t}`; };
  const groups = [
    missedNow?.length ? <section key="calls" className={css.need} aria-label="Missed calls">
      <h4><PhoneMissed size={14} aria-hidden="true" />Missed calls<i data-tone="late">{missedNow.length}</i></h4>
      {missedNow.map((m) => <div key={m.id} className={css.needRow}>
        <button type="button" className={css.needMain} onClick={() => onChoose(m.channelId)} title="Open the conversation">
          <b>{m.title}</b><small>{m.video ? "Video call" : "Voice call"}{m.peer ? "" : m.caller ? ` from ${m.caller.name}` : ""} · {callTime(m.at)}{m.count > 1 ? ` · ${m.count} missed` : ""}</small></button>
        <button type="button" className={css.nudge} onClick={() => { setCalledBack((x) => [...x, m.channelId]); startCall(m.channelId, m.video); }} aria-label={`Call ${m.title} back`}>
          {m.video ? <Video size={12} aria-hidden="true" /> : <Phone size={12} aria-hidden="true" />}Call back</button>
      </div>)}
      <button type="button" className={css.needMore} onClick={() => openInPanel({ href: "/calls", title: "Calls" })}>All calls</button>
    </section> : null,
    openTasks === null || openTasks.length ? <section key="tasks" className={css.need} aria-label="Tasks given to you">
      <h4><CircleCheck size={14} aria-hidden="true" />Tasks for you{openTasks?.length ? <i>{openTasks.length}</i> : null}</h4>
      {openTasks === null ? <Skeleton /> : openTasks.map((t) => { const due = dueWords(t.dueOn); return <div key={t.id} className={css.needRow}>
        <button type="button" className={css.needMain} onClick={() => openInPanel({ href: `/tasks/${t.id}`, title: t.title.slice(0, 40) })}>
          <b>{t.title}</b><small>{[t.projectName, t.status === "blocked" ? "Blocked" : t.status === "in_progress" ? "Doing" : null].filter(Boolean).join(" · ") || "No project"}</small></button>
        {due ? <span className={css.due} data-late={due.late || undefined}>{due.late ? <AlarmClock size={12} aria-hidden="true" /> : null}{due.text}</span> : null}
        <button type="button" className={css.doneBtn} onClick={() => void finish(t)} aria-label={`Mark “${t.title}” done`} title="Mark done"><Check size={15} aria-hidden="true" /></button>
      </div>; })}
      <button type="button" className={css.needMore} onClick={() => openInPanel({ href: "/tasks?scope=me", title: "My tasks" })}>All my tasks</button>
    </section> : null,
    steps === null || steps.length ? <section key="steps" className={css.need} aria-label="Your process steps">
      <h4><ListChecks size={14} aria-hidden="true" />Your steps{steps?.length ? <i>{steps.length}</i> : null}</h4>
      {steps === null ? <Skeleton /> : steps.map((s) => { const due = dueWords(s.due_on ?? s.dueOn ?? s.due); return <div key={s.id} className={css.needRow}>
        <button type="button" className={css.needMain} onClick={() => openInPanel({ href: s.href, title: s.title.slice(0, 40) })}><b>{s.title}</b><small>{s.run ?? s.process ?? "Process"}</small></button>
        {due ? <span className={css.due} data-late={due.late || undefined}>{due.text}</span> : null}</div>; })}
      <button type="button" className={css.needMore} onClick={() => openInPanel({ href: "/me/steps", title: "My steps" })}>All my steps</button>
    </section> : null,
    mentions.length ? <section key="mentions" className={css.need} aria-label="Chats that mention you">
      <h4><AtSign size={14} aria-hidden="true" />Mentions<i>{mentions.length}</i></h4>
      {mentions.slice(0, 4).map((c) => <div key={c.id} className={css.needRow}><button type="button" className={css.needMain} onClick={() => onChoose(c.id)}><b>{c.name}</b><small>{c.preview ?? "You were mentioned"}</small></button></div>)}
    </section> : null,
    data.canLead && (late === null || late.length) ? <section key="late" className={css.need} aria-label="Projects late or blocked">
      <h4><FolderKanban size={14} aria-hidden="true" />Late or blocked{late?.length ? <i data-tone="late">{late.length}</i> : null}</h4>
      {late === null ? <Skeleton /> : late.map((p) => { const owner = data.people.find((x) => x.id === p.ownerId);
        const what = [p.overdue ? `${p.overdue} late` : null, p.blocked ? `${p.blocked} blocked` : null].filter(Boolean).join(" · ");
        return <div key={p.id} className={css.needRow}>
          <button type="button" className={css.needMain} onClick={() => openInPanel({ href: `/tasks/projects/${p.id}`, title: p.name.slice(0, 40) })}><b>{p.name}</b><small>{what}{p.ownerName ? ` · ${p.ownerName}` : ""}</small></button>
          {owner && owner.id !== data.viewer ? <button type="button" className={css.nudge} onClick={() => onNudge(owner, `Hi ${owner.name.split(" ")[0]}, ${p.name} has ${what}. Can you take a look and tell me what you need?`)} title={`Message ${owner.name} about it`}><Send size={12} aria-hidden="true" />Nudge</button> : null}
        </div>; })}
      <button type="button" className={css.needMore} onClick={() => openInPanel({ href: "/tasks?view=projects", title: "Projects" })}>All projects</button>
    </section> : null,
  ].filter(Boolean);
  const empty = !missedNow?.length && openTasks?.length === 0 && steps?.length === 0 && !mentions.length && (!data.canLead || late?.length === 0);
  return <section className={css.needs} aria-label="Needs you">
    <h3>Needs you</h3>
    {empty ? <p className={css.clear}>Nothing is waiting for you. Give someone work by typing @ their name, or open a page with /open.</p> : <div className={css.needGrid}>{groups}</div>}
  </section>;
}
function Skeleton() { return <div className={css.needSk} aria-hidden="true"><span /><span /></div>; }
