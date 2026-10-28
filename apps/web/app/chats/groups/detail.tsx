"use client";
// GROUPS-HUB: one group in a side panel (a sheet on a phone): its brief, what it is about (edited in place: what a
// person sets stays over what the name says), its people and AI employees with their roles, its work (tasks, files,
// client and project), what the AI employees said about it, and what is left to review.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Building2, CheckCircle2, Clock3, ExternalLink, Eye, FileText, FolderKanban, History, ListChecks, Loader2, MessageCircle, RotateCcw, ScanSearch, Sparkles, UserPlus, X } from "lucide-react";
import { Avatar } from "../../ui";
import { AiBadge, Combobox, Drawer, DrawerFooter, DrawerSection, PeopleInput, PersonSelect, Select } from "../../kit";
import { get, send } from "../net";
import css from "./hub.module.css";
import { GroupMark, Field } from "./hub";
import { ago, displayName, HEALTH, KIND, monthLabel, ROLE, SEGMENT, SERVICE, SIGNAL, STAGE, STATUS, type Group, type HubData, type Kind, type Status } from "./model";
import { fileUrl } from "../files";

type Member = { id: string; name: string; side: string; role: string; pod: string | null; username: string | null; aiRole: string | null };
type Job = { id: string; kind: "summary" | "extract" | "draft"; status: string; result: Record<string, unknown> | null; error: string | null; createdAt: string; finishedAt: string | null; agent: string; agentId: string };
export type Suggestion = { id: string; kind: string; title: string; detail: Record<string, unknown>; source: string; confidence: string | null; createdAt: string; channelId?: string; group?: string };
export type Detail = { group: Group; members: Member[]; tasks: { id: string; title: string; status: string; dueAt: string | null; assignee: string | null }[];
  files: { id: string; name: string; mime: string; at: string }[]; suggestions: Suggestion[]; jobs: Job[]; talkers: { name: string; side: string; n: number }[];
  unmapped: { label: string; messages: number; firstAt: string; lastAt: string }[]; canManage: boolean };

export function GroupDetail({ group, data, onClose, reload, say }: { group: Group; data: HubData; onClose: () => void; reload: () => Promise<void>; say: (t: string, tone?: "error") => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pane, setPane] = useState("brief");
  const load = useCallback(async () => { try { setD(await get<Detail>(`chats/hub/groups/${group.id}`)); setErr(null); } catch (e) { setErr((e as Error).message); } }, [group.id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the panel loads its group when it opens
  useEffect(() => { void load(); }, [load]);
  const g = d?.group ?? group;
  const refresh = async () => { await Promise.all([load(), reload()]); };
  const setField = async (fields: Record<string, unknown>, done = "Saved") => {
    try { await send("chats/hub/set", { ids: [g.id], fields }); await refresh(); say(done); } catch (e) { say((e as Error).message, "error"); }
  };
  const review = (d?.suggestions.length ?? 0) + (d?.unmapped.length ?? 0);
  const ais = d?.members.filter((m) => m.side === "agent") ?? [];
  const context = <span className={css.ctx}>
    {g.kind ? <span className={css.kind} data-kind={g.kind}>{KIND[g.kind]}</span> : null}
    <span className={css.pill} data-status={g.status}>{STATUS[g.status]}</span>
    {g.imported ? <span className={css.waTag}><History size={12} aria-hidden="true" />Imported from WhatsApp</span> : null}
    {g.health ? <span className={css.healthTag} data-health={g.health}>{HEALTH[g.health]}</span> : null}
  </span>;
  const panes = [
    { key: "brief", label: "Brief", content: d ? <Brief d={d} data={data} setField={setField} /> : <Loading err={err} /> },
    { key: "people", label: "People", count: g.members + ais.length, content: d ? <People d={d} data={data} refresh={refresh} say={say} /> : <Loading err={err} /> },
    { key: "work", label: "Work", count: g.openTasks || undefined, content: d ? <Work d={d} /> : <Loading err={err} /> },
    { key: "ai", label: "AI", count: ais.length || undefined, content: d ? <Ai d={d} data={data} refresh={refresh} say={say} openPeople={() => setPane("people")} /> : <Loading err={err} /> },
    { key: "review", label: "Review", count: review || undefined, content: d ? <GroupReview d={d} data={data} refresh={refresh} say={say} /> : <Loading err={err} /> },
  ];
  return <Drawer className={css.vars} title={displayName(g.name)} icon={<GroupMark g={g} size={32} />} context={context} onClose={onClose} size="xl" panes={panes} pane={pane} onPane={setPane} snap="full"
    footer={<DrawerFooter primary={g.member ? <Link className={css.primary} href={`/chats?channel=${g.id}`}><MessageCircle size={16} aria-hidden="true" />Open chat</Link>
      // GROUP-ACCESS: a client group the organisation lets this viewer read opens read-only; Join to post is in the chat.
      : g.canRead ? <Link className={css.primary} href={`/chats?channel=${g.id}`} data-read-chat=""><Eye size={16} aria-hidden="true" />Read the chat</Link>
      : <span className={css.small}>You are not in this group: you see what it is about, not its messages.</span>}>
      {g.clientId ? <Link className={css.ghostBtn} href={`/clients/${g.clientId}`}><Building2 size={15} aria-hidden="true" />Client</Link> : null}
      {g.projectId ? <Link className={css.ghostBtn} href={`/projects/${g.projectId}`}><FolderKanban size={15} aria-hidden="true" />Project</Link> : null}
    </DrawerFooter>} />;
}

function Loading({ err }: { err: string | null }) {
  return err ? <p className={css.errorText} role="alert">{err}</p> : <p className={css.loading}><Loader2 size={16} className={css.spin} aria-hidden="true" />Loading…</p>;
}

function Brief({ d, data, setField }: { d: Detail; data: HubData; setField: (f: Record<string, unknown>, done?: string) => Promise<void> }) {
  const g = d.group, can = d.canManage;
  const summary = d.jobs.find((j) => j.kind === "summary" && j.status === "done")?.result as { happening?: string; pending?: string[]; waiting?: string[]; risks?: string[]; text?: string } | undefined;
  const projects = useMemo(() => data.projects.filter((p) => !g.clientId || p.clientId === g.clientId || p.id === g.projectId), [data.projects, g.clientId, g.projectId]);
  const p = g.parsed;
  const read = p ? [p.pod ? `Pod ${p.pod}` : null, p.project, p.client ? `client ${p.client}` : null, p.area, p.month ? monthLabel(p.month) : null].filter(Boolean).join(" · ") : "";
  const manual = g.manual.filter((f) => ["kind", "segments", "services", "client", "project", "pod", "area", "city", "period"].includes(f));
  return <>
    <DrawerSection title="Right now">
      <ul className={css.facts}>
        <li data-tone={g.waitingSince ? "warn" : "ok"}><Clock3 size={15} aria-hidden="true" />{g.waitingSince ? <span><b>{g.waitingWho ?? "A client"}</b> is waiting since {ago(g.waitingSince)}</span> : <span>Nobody is waiting on the team</span>}</li>
        <li><MessageCircle size={15} aria-hidden="true" /><span>Last message {ago(g.lastAt).toLowerCase()} · {g.messages7} this week · {g.messages.toLocaleString("en-IN")} in all{g.imported ? ` (${g.imported.toLocaleString("en-IN")} imported)` : ""}</span></li>
        <li><ListChecks size={15} aria-hidden="true" /><span>{g.openTasks ? `${g.openTasks} open task${g.openTasks === 1 ? "" : "s"}` : "No open tasks linked"}{g.unread ? ` · ${g.unread} unread for you` : ""}</span></li>
        {d.talkers.length ? <li><Bot size={15} aria-hidden="true" /><span>Most active this month: {d.talkers.map((t) => `${t.name} (${t.n})`).join(", ")}</span></li> : null}
      </ul>
      {g.insight ? <div className={css.insight}>
        {g.insight.stages?.length ? <div className={css.stages} aria-label="Stages seen in the WhatsApp history">{g.insight.stages.map((st, i) => <span key={i} data-last={i === g.insight!.stages!.length - 1 || undefined}>{STAGE[st] ?? st}</span>)}</div> : null}
        <div className={css.kpis}>
          {g.insight.teamMin != null ? <span><b>{g.insight.teamMin} min</b>team answers (median)</span> : null}
          {g.insight.clientMin != null ? <span><b>{g.insight.clientMin > 120 ? `${Math.round(g.insight.clientMin / 60)} h` : `${g.insight.clientMin} min`}</b>client answers</span> : null}
          {g.insight.daysToLive != null ? <span><b>{Math.round(g.insight.daysToLive)} d</b>start to live</span> : null}
          {g.insight.revisions != null ? <span><b>{g.insight.revisions}</b>revisions</span> : null}
        </div>
        {g.insight.signals ? <div className={css.toggles}>{Object.entries(g.insight.signals).sort((a, b) => b[1] - a[1]).map(([k, n]) => <span key={k} className={css.signal} data-signal={k}>{SIGNAL[k] ?? k} {n}</span>)}</div> : null}
      </div> : null}
      {summary ? <div className={css.summary}>
        <span className={css.summaryHead}><Sparkles size={14} aria-hidden="true" />{d.jobs.find((j) => j.kind === "summary")?.agent} · {ago(d.jobs.find((j) => j.kind === "summary")?.finishedAt ?? null)}</span>
        {summary.happening || summary.text ? <p>{summary.happening ?? summary.text}</p> : null}
        {summary.pending?.length ? <><b>Pending</b><ul>{summary.pending.map((x, i) => <li key={i}>{x}</li>)}</ul></> : null}
        {summary.waiting?.length ? <><b>Who is waiting</b><ul>{summary.waiting.map((x, i) => <li key={i}>{x}</li>)}</ul></> : null}
        {summary.risks?.length ? <><b>Watch</b><ul>{summary.risks.map((x, i) => <li key={i}>{x}</li>)}</ul></> : null}
      </div> : null}
      {g.healthNote && !summary ? <p className={css.small}>{g.healthNote}</p> : null}
    </DrawerSection>
    <DrawerSection title="What it is about" help="Pulse reads the group's name (pod, project, client, area, month, segment codes R/P/L/C/M). Anything you change here stays when names are read again.">
      {read ? <p className={css.readLine}>Read from the name: <b>{read}</b>{p?.match?.project ? <span className={css.muted}> · project match {Math.round(p.match.project.score * 100)}%</span> : null}
        {manual.length && can ? <button type="button" className={css.linkBtn} onClick={() => void setField(Object.fromEntries(manual.map((f) => [f === "client" ? "clientId" : f === "project" ? "projectId" : f, null])), "Back to what the name says")}><RotateCcw size={13} aria-hidden="true" />Use the name again</button> : null}</p> : null}
      <div className={css.grid2}>
        <Field label="Type"><Select<Kind> label="Type" value={g.kind} disabled={!can} onChange={(v) => void setField({ kind: v })} options={Object.entries(KIND).map(([value, label]) => ({ value: value as Kind, label }))} size="sm" /></Field>
        <Field label="Status"><Select<Status> label="Status" value={g.statusSet ? g.status : null} hint={`${STATUS[g.status]} (from activity)`} noneLabel="From activity" disabled={!can} onChange={(v) => void setField({ status: v })} options={Object.entries(STATUS).map(([value, label]) => ({ value: value as Status, label }))} size="sm" /></Field>
        <Field label="Client"><Combobox label="Client" value={g.clientId} disabled={!can} noneLabel="No client" hint={p?.client ?? undefined} onChange={(v) => void setField({ clientId: v })} options={data.clients.map((c) => ({ value: c.id, label: c.name }))} placeholder="Link a client" size="sm" /></Field>
        <Field label="Project"><Combobox label="Project" value={g.projectId} disabled={!can} noneLabel="No project" hint={p?.project ?? undefined} onChange={(v) => void setField({ projectId: v })} options={projects.map((x) => ({ value: x.id, label: x.name, detail: x.status !== "active" ? x.status : undefined }))} placeholder="Link a project" size="sm" /></Field>
        <Field label="Pod"><Select label="Pod" value={g.pod} disabled={!can} noneLabel="No pod" onChange={(v) => void setField({ pod: v })} options={[...new Set(["Pod 1", "Pod 2", ...(g.pod ? [g.pod] : [])])].map((x) => ({ value: x, label: x }))} size="sm" /></Field>
        <Field label="Owner"><PersonSelect label="Owner" people={data.people} value={g.ownerId} noneLabel="No owner" size="sm" onChange={(x) => can && void setField({ ownerId: x?.id ?? null })} /></Field>
        <Field label="Area"><TextSave value={g.area ?? ""} disabled={!can} placeholder="e.g. Baner" onSave={(v) => setField({ area: v || null })} /></Field>
        <Field label="City"><TextSave value={g.city ?? ""} disabled={!can} placeholder="Pune unless named" onSave={(v) => setField({ city: v || null })} /></Field>
        <Field label="Period"><input className={css.input} type="month" value={g.period ?? ""} disabled={!can} onChange={(e) => void setField({ period: e.target.value || null })} aria-label="Period" /></Field>
      </div>
      <Field label="Segment"><Toggles values={g.segments} all={SEGMENT} disabled={!can} onChange={(v) => void setField({ segments: v })} /></Field>
      <Field label="Services"><Toggles values={g.services} all={SERVICE} disabled={!can} onChange={(v) => void setField({ services: v })} /></Field>
      <Field label="Tags"><Tags tags={g.tags} disabled={!can} onAdd={(t) => void setField({ addTags: [t] }, `Tagged “${t}”`)} onRemove={(t) => void setField({ removeTags: [t] })} /></Field>
    </DrawerSection>
  </>;
}

function TextSave({ value, onSave, disabled, placeholder }: { value: string; onSave: (v: string) => Promise<void>; disabled?: boolean; placeholder?: string }) {
  const [v, setV] = useState(value);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- a saved value from the server replaces the typed one
  useEffect(() => setV(value), [value]);
  return <input className={css.input} value={v} disabled={disabled} placeholder={placeholder} maxLength={60} onChange={(e) => setV(e.target.value)}
    onBlur={() => { if (v.trim() !== value) void onSave(v.trim()); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
}
function Toggles({ values, all, onChange, disabled }: { values: string[]; all: Record<string, string>; onChange: (v: string[]) => void; disabled?: boolean }) {
  return <div className={css.toggles}>{Object.entries(all).map(([k, label]) => <button key={k} type="button" disabled={disabled} aria-pressed={values.includes(k)} className={css.toggle}
    onClick={() => onChange(values.includes(k) ? values.filter((x) => x !== k) : [...values, k])}>{label}</button>)}</div>;
}
function Tags({ tags, onAdd, onRemove, disabled }: { tags: string[]; onAdd: (t: string) => void; onRemove: (t: string) => void; disabled?: boolean }) {
  const [t, setT] = useState("");
  return <div className={css.toggles}>
    {tags.map((x) => <span key={x} className={css.tagChip}>{x}{disabled ? null : <button type="button" onClick={() => onRemove(x)} aria-label={`Remove tag ${x}`}><X size={12} aria-hidden="true" /></button>}</span>)}
    {disabled ? null : <form onSubmit={(e) => { e.preventDefault(); if (t.trim()) { onAdd(t.trim().toLowerCase()); setT(""); } }}><input className={css.tagInput} value={t} onChange={(e) => setT(e.target.value)} placeholder="Add a tag" maxLength={40} aria-label="Add a tag" /></form>}
  </div>;
}

function People({ d, data, refresh, say }: { d: Detail; data: HubData; refresh: () => Promise<void>; say: (t: string, tone?: "error") => void }) {
  const [add, setAdd] = useState<string[]>([]), [agent, setAgent] = useState<string | null>(null), [role, setRole] = useState<"observer" | "assistant" | "coordinator">("observer");
  const staff = d.members.filter((m) => m.side === "staff"), client = d.members.filter((m) => m.side !== "staff" && m.side !== "agent"), ais = d.members.filter((m) => m.side === "agent");
  const custom = d.group.channelKind === "custom";
  const setRoleOf = async (agentId: string, r: string | null) => {
    try { await send("chats/hub/agents", { ids: [d.group.id], agentId, role: r }); await refresh(); say(r ? `Role: ${ROLE[r].label}` : "Taken out of the group"); } catch (e) { say((e as Error).message, "error"); }
  };
  return <>
    <DrawerSection title={`AI employees (${ais.length})`} help="An AI employee reads only the groups it is in. Observer: reads and summarises when asked. Assistant: answers when @mentioned. Coordinator: follows the group and follows up, asking first. Anything for a client goes to a person to approve.">
      {ais.length ? <ul className={css.memberList}>{ais.map((m) => <li key={m.id}>
        <Avatar name={m.name} id={m.id} size={32} ai /><span className={css.memberName}><b>{m.name}</b><AiBadge /></span>
        <Select label={`${m.name}'s role`} value={(m.aiRole ?? "profile") as string} disabled={!d.canManage} size="sm" variant="chip" onChange={(v) => void setRoleOf(m.id, v === "profile" ? "assistant" : v)}
          options={["observer", "assistant", "coordinator", ...(m.aiRole ? [] : ["profile"])].map((r) => ({ value: r, label: ROLE[r].label, detail: ROLE[r].hint }))} />
        {d.canManage && custom ? <button type="button" className={css.iconBtn} onClick={() => void setRoleOf(m.id, null)} aria-label={`Take ${m.name} out`}><X size={15} aria-hidden="true" /></button> : null}
      </li>)}</ul> : <p className={css.small}>No AI employee is in this group yet.</p>}
      {d.canManage ? <div className={css.addAi}>
        <Combobox label="Add an AI employee" value={agent} onChange={setAgent} placeholder="Add an AI employee" size="sm"
          options={data.agents.filter((a) => !ais.some((m) => m.id === a.id)).map((a) => ({ value: a.id, label: a.name, detail: a.title || undefined, icon: <Avatar name={a.name} id={a.id} size={20} ai /> }))} />
        <Select label="Role" value={role} onChange={(v) => setRole((v ?? "observer") as typeof role)} size="sm" options={(["observer", "assistant", "coordinator"] as const).map((r) => ({ value: r, label: ROLE[r].label, detail: ROLE[r].hint }))} />
        <button type="button" className={css.primary} disabled={!agent} onClick={async () => { await setRoleOf(agent!, role); setAgent(null); }}><Bot size={15} aria-hidden="true" />Add</button>
      </div> : null}
    </DrawerSection>
    <DrawerSection title={`Team (${staff.length})`}>
      <ul className={css.memberList}>{staff.map((m) => <li key={m.id}><Avatar name={m.name} id={m.id} size={32} /><span className={css.memberName}><b>{m.name}</b><span className={css.muted}>{[m.pod, m.role === "admin" ? "group admin" : null].filter(Boolean).join(" · ")}</span></span></li>)}</ul>
      {d.canManage && custom ? <div className={css.addPeople}><PeopleInput label="Add colleagues" people={data.people} value={add} onChange={setAdd} exclude={staff.map((m) => m.id)} addLabel="Add a colleague" />
        <button type="button" className={css.primary} disabled={!add.length} onClick={async () => { try { await send("chats/hub/people", { ids: [d.group.id], personIds: add }); setAdd([]); await refresh(); say("Added"); } catch (e) { say((e as Error).message, "error"); } }}><UserPlus size={15} aria-hidden="true" />Add</button></div> : null}
    </DrawerSection>
    {client.length ? <DrawerSection title={`Client side (${client.length})`}>
      <ul className={css.memberList}>{client.map((m) => <li key={m.id}><Avatar name={m.name} id={m.id} size={32} /><span className={css.memberName}><b>{m.name}</b><span className={css.muted}>Client contact</span></span></li>)}</ul>
    </DrawerSection> : null}
  </>;
}

function Work({ d }: { d: Detail }) {
  const open = d.tasks.filter((t) => !["done", "accepted", "cancelled"].includes(t.status)), done = d.tasks.filter((t) => ["done", "accepted"].includes(t.status));
  return <>
    <DrawerSection title={`Open tasks (${open.length})`} help="Tasks of the group's project, and tasks that post their updates in this group.">
      {open.length ? <ul className={css.taskList}>{open.map((t) => <li key={t.id}><Link href={`/tasks/${t.id}`}><span>{t.title}</span><span className={css.muted}>{[t.assignee, t.dueAt ? `due ${new Date(t.dueAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}` : null, t.status.replace("_", " ")].filter(Boolean).join(" · ")}</span></Link></li>)}</ul>
        : <p className={css.small}>No open tasks. Accept tasks found in the chat under Review, or link the group to its project.</p>}
      {done.length ? <p className={css.small}>{done.length} done</p> : null}
    </DrawerSection>
    <DrawerSection title="Files">
      {d.files.length ? <ul className={css.fileList}>{d.files.map((f) => <li key={f.id}><a href={fileUrl(f)} target="_blank" rel="noreferrer"><FileText size={15} aria-hidden="true" /><span>{f.name}</span><span className={css.muted}>{ago(f.at)}</span></a></li>)}</ul>
        : <p className={css.small}>{d.group.member ? "No files shared here yet." : "Only members see the group's files."}</p>}
    </DrawerSection>
    <DrawerSection title="Linked">
      <div className={css.linkRow}>
        {d.group.clientId ? <Link className={css.ghostBtn} href={`/clients/${d.group.clientId}`}><Building2 size={15} aria-hidden="true" />{d.group.client}</Link> : <span className={css.muted}>No client linked</span>}
        {d.group.projectId ? <Link className={css.ghostBtn} href={`/projects/${d.group.projectId}`}><FolderKanban size={15} aria-hidden="true" />{d.group.project}</Link> : <span className={css.muted}>No project linked</span>}
        {d.group.clientId ? <Link className={css.ghostBtn} href={`/quotes?client=${d.group.clientId}`}><ExternalLink size={15} aria-hidden="true" />Quotes</Link> : null}
      </div>
    </DrawerSection>
  </>;
}

const ASKS = [{ kind: "summary", label: "Summarise", hint: "What is happening, what is pending, who is waiting" }, { kind: "extract", label: "Find tasks and approvals", hint: "Tasks and approvals asked in the chat, to accept one by one" },
  { kind: "draft", label: "Draft a reply", hint: "A reply for you to edit and send yourself" }] as const;
function Ai({ d, data, refresh, say, openPeople }: { d: Detail; data: HubData; refresh: () => Promise<void>; say: (t: string, tone?: "error") => void; openPeople: () => void }) {
  const ais = d.members.filter((m) => m.side === "agent");
  const [agent, setAgent] = useState<string | null>(ais[0]?.id ?? null), [note, setNote] = useState("");
  const [waiting, setWaiting] = useState<string | null>(null);
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const tick = async () => { for (let i = 0; i < 120 && !stop; i++) { await new Promise((r) => setTimeout(r, 3000)); const j = await get<Job>(`chats/hub/jobs/${waiting}`).catch(() => null);
      if (j && (j.status === "done" || j.status === "failed")) { setWaiting(null); await refresh(); say(j.status === "done" ? `${j.agent} answered` : `${j.agent} could not answer: ${j.error ?? "try again"}`, j.status === "done" ? undefined : "error"); return; } } };
    void tick(); return () => { stop = true; };
  }, [waiting, refresh, say]);
  if (!ais.length) return <DrawerSection title="AI employees"><p className={css.small}>Put an AI employee in this group first (People), as an observer if it should only read and summarise.</p>
    <button type="button" className={css.ghostBtn} onClick={openPeople}><Bot size={15} aria-hidden="true" />Add an AI employee</button></DrawerSection>;
  const ask = async (kind: string) => {
    try { const r = await send<{ id: string }>(`chats/hub/groups/${d.group.id}/ask`, { agentId: agent, kind, note }); setWaiting(r.id); setNote(""); await refresh(); say("Asked; the answer appears here"); } catch (e) { say((e as Error).message, "error"); }
  };
  const latest = (k: string) => d.jobs.find((j) => j.kind === k);
  return <>
    <DrawerSection title="Ask an AI employee in this group">
      <div className={css.askRow}>
        <Select label="AI employee" value={agent} onChange={setAgent} size="sm" options={ais.map((m) => ({ value: m.id, label: m.name, detail: ROLE[m.aiRole ?? "profile"].label }))} />
        <input className={css.input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to focus on (optional)" maxLength={500} aria-label="Note for the AI employee" />
      </div>
      <div className={css.askBtns}>{ASKS.map((a) => <button key={a.kind} type="button" className={css.askBtn} disabled={!agent || !!waiting} onClick={() => void ask(a.kind)}>
        <Sparkles size={15} aria-hidden="true" /><b>{a.label}</b><span>{a.hint}</span></button>)}</div>
      {waiting ? <p className={css.loading}><Loader2 size={15} className={css.spin} aria-hidden="true" />Waiting for the answer (usually under a minute; its runtime takes jobs in turn)…</p> : null}
      <p className={css.small}>It reads this group&apos;s recent messages{d.group.imported ? ", its imported WhatsApp history" : ""} and open tasks, with names, phone numbers, e-mail and postal addresses replaced by ids before anything reaches an AI engine; the names come back in its answer. Nothing is posted: you send replies yourself.</p>
    </DrawerSection>
    {ASKS.map((a) => { const j = latest(a.kind); if (!j) return null; return <DrawerSection key={a.kind} title={`${a.label} · ${j.agent}`} aside={<span className={css.muted}>{j.status === "done" ? ago(j.finishedAt) : j.status === "failed" ? "failed" : "waiting"}</span>}>
      {j.status === "failed" ? <p className={css.errorText}>{j.error}</p> : j.status !== "done" ? <p className={css.loading}><Loader2 size={15} className={css.spin} aria-hidden="true" />Waiting…</p> : <JobResult j={j} groupId={d.group.id} member={d.group.member} />}
    </DrawerSection>; })}
  </>;
}
function JobResult({ j, groupId, member }: { j: Job; groupId: string; member: boolean }) {
  const r = j.result ?? {};
  if (j.kind === "draft") {
    const reply = String(r.reply ?? r.text ?? "");
    return <div className={css.draft}><p>{reply}</p>{r.why ? <p className={css.small}>{String(r.why)}</p> : null}
      <div className={css.linkRow}><button type="button" className={css.ghostBtn} onClick={() => void navigator.clipboard?.writeText(reply)}>Copy</button>
        {member ? <Link className={css.primary} href={`/chats?channel=${groupId}`}>Open chat to send</Link> : null}</div></div>;
  }
  if (j.kind === "extract") { const items = Array.isArray(r.items) ? r.items as Record<string, unknown>[] : []; return <p className={css.small}>{items.length ? `${items.length} found: they are under Review, to accept one by one.` : "Nothing open found in the chat."}</p>; }
  return <div className={css.summary}>{r.happening || r.text ? <p>{String(r.happening ?? r.text)}</p> : null}
    {Array.isArray(r.pending) && r.pending.length ? <><b>Pending</b><ul>{(r.pending as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul></> : null}
    {Array.isArray(r.waiting) && r.waiting.length ? <><b>Who is waiting</b><ul>{(r.waiting as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul></> : null}</div>;
}

function GroupReview({ d, data, refresh, say }: { d: Detail; data: HubData; refresh: () => Promise<void>; say: (t: string, tone?: "error") => void }) {
  const [scanning, setScanning] = useState(false);
  return <>
    {d.unmapped.length ? <DrawerSection title={`Who is this? (${d.unmapped.length})`} help="Senders of the imported history Pulse could not match to a colleague or a client contact. Choose who each one is; all their messages follow.">
      <SenderList rows={d.unmapped.map((u) => ({ ...u, channelId: d.group.id }))} data={data} refresh={refresh} say={say} disabled={!d.canManage} />
    </DrawerSection> : null}
    <DrawerSection title={`Suggestions (${d.suggestions.length})`} aside={d.group.imported && d.group.member ? <button type="button" className={css.linkBtn} disabled={scanning} onClick={async () => {
      setScanning(true); try { const r = await send<{ added: number; looked?: number; note?: string }>(`chats/hub/groups/${d.group.id}/scan`); await refresh(); say(r.note ?? `Looked at ${r.looked} messages: ${r.added} new suggestion${r.added === 1 ? "" : "s"}`); } catch (e) { say((e as Error).message, "error"); } finally { setScanning(false); } }}>
      <ScanSearch size={14} aria-hidden="true" />Look through the history</button> : null}>
      {d.suggestions.length ? <SuggestionList rows={d.suggestions} data={data} refresh={refresh} say={say} /> : <p className={css.small}><CheckCircle2 size={14} aria-hidden="true" /> Nothing to review here.</p>}
    </DrawerSection>
  </>;
}

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/^(mr|mrs|ms|miss|dr)\.?\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
/** Who an imported sender most likely is: a colleague or client contact with the same name (first and last). */
function guessWho(label: string, everyone: { id: string; name: string }[]): string | null {
  const l = fold(label); if (!l || /^number ending/.test(l)) return null;
  const same = everyone.filter((p) => fold(p.name) === l);
  if (same.length === 1) return same[0].id;
  const starts = everyone.filter((p) => fold(p.name).startsWith(l + " ") || l.startsWith(fold(p.name) + " "));
  return starts.length === 1 ? starts[0].id : null;
}
export function SenderList({ rows, data, refresh, say, disabled, showGroup }: { rows: { channelId: string; group?: string; label: string; messages: number; firstAt: string; lastAt: string }[]; data: HubData; refresh: () => Promise<void>; say: (t: string, tone?: "error") => void; disabled?: boolean; showGroup?: boolean }) {
  const everyone = useMemo(() => [...data.people.map((p) => ({ ...p, role: "Colleague" })), ...(data.contacts ?? []).map((c) => ({ id: c.id, name: c.name, pod: c.client ? `Client · ${c.client}` : "Client contact", role: null, username: null }))], [data.people, data.contacts]);
  const guesses = useMemo(() => Object.fromEntries(rows.map((u) => [`${u.channelId}:${u.label}`, guessWho(u.label, everyone)])), [rows, everyone]);
  const [chosen, setPick] = useState<Record<string, string | null>>({});
  const pick = { ...guesses, ...chosen };
  const sure = rows.filter((u) => guesses[`${u.channelId}:${u.label}`] && !(`${u.channelId}:${u.label}` in chosen));
  const [busy, setBusy] = useState(false);
  const mapAll = async () => {
    setBusy(true); let n = 0;
    try { for (const u of sure) { const r = await send<{ mapped: number }>(`chats/hub/groups/${u.channelId}/map-sender`, { label: u.label, personId: guesses[`${u.channelId}:${u.label}`] }); n += r.mapped; }
      await refresh(); say(`Mapped ${sure.length} senders (${n.toLocaleString("en-IN")} messages)`); }
    catch (e) { await refresh(); say((e as Error).message, "error"); } finally { setBusy(false); }
  };
  return <>{sure.length > 1 && !disabled ? <div className={css.laneBar}><span className={css.small}><b>{sure.length}</b> senders have exactly the same name as someone in Pulse.</span>
    <button type="button" className={css.primary} disabled={busy} onClick={() => void mapAll()}>{busy ? <Loader2 size={15} className={css.spin} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}Map all {sure.length}</button></div> : null}
  <ul className={css.queue}>{rows.map((u) => { const k = `${u.channelId}:${u.label}`; return <li key={k} className={css.qItem}>
    <span className={css.qText}><b>{u.label}</b>{guesses[k] && pick[k] === guesses[k] ? <span className={css.guess}>Same name as {everyone.find((p) => p.id === guesses[k])?.name}</span> : null}<span className={css.muted}>{u.messages} message{u.messages === 1 ? "" : "s"} · {new Date(u.firstAt).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}–{new Date(u.lastAt).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}{showGroup && u.group ? ` · ${displayName(u.group)}` : ""}</span></span>
    <span className={css.qActions}>
      <PersonSelect label={`Who is ${u.label}`} people={everyone} value={pick[k] ?? null} size="sm" placeholder="Choose who" onChange={(p) => setPick((m) => ({ ...m, [k]: p?.id ?? null }))} />
      <button type="button" className={css.primary} disabled={disabled || !pick[k]} onClick={async () => { try { const r = await send<{ mapped: number }>(`chats/hub/groups/${u.channelId}/map-sender`, { label: u.label, personId: pick[k] }); await refresh(); say(`${r.mapped} messages now show ${everyone.find((p) => p.id === pick[k])?.name}`); } catch (e) { say((e as Error).message, "error"); } }}>Map</button>
    </span>
  </li>; })}</ul></>;
}

export function SuggestionList({ rows, data, refresh, say, showGroup, onOpen }: { rows: Suggestion[]; data: HubData; refresh: () => Promise<void>; say: (t: string, tone?: "error") => void; showGroup?: boolean; onOpen?: (id: string) => void }) {
  const [who, setWho] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // AI-TASKS: AI employees the viewer may give work to, after the people, with their role.
  const doers = useMemo(() => [...data.people, ...data.agents.filter((a) => a.takesTasks).map((a) => ({ id: a.id, name: a.name, pod: null, username: a.username, role: a.title, agent: true, employeeId: a.employeeId }))], [data.people, data.agents]);
  const act = async (s: Suggestion, accept: boolean) => {
    setBusy(s.id);
    try {
      if (accept) await send(`chats/hub/suggestions/${s.id}/accept`, { assigneeId: who[s.id] ?? undefined, dueOn: s.detail.due ?? undefined });
      else await send(`chats/hub/suggestions/${s.id}/dismiss`);
      await refresh(); say(accept ? (s.kind === "task" || s.kind === "approval" ? "Task made and followed in the group" : "Linked") : "Dismissed");
    } catch (e) { say((e as Error).message, "error"); } finally { setBusy(null); }
  };
  return <ul className={css.queue}>{rows.map((s) => <li key={s.id} className={css.qItem} data-kind={s.kind}>
    <span className={css.qText}>
      <b>{s.title}</b>
      <span className={css.muted}>{[showGroup && s.group ? displayName(s.group) : null, s.source === "names" ? "from the group's name" : s.source === "ai" ? "found by an AI employee" : s.source === "history" ? "found in the history"
        : s.detail.intent ? `read from the history as ${s.detail.intent === "change" ? "a change request" : s.detail.intent === "approval" ? "an approval" : "a request"}` : "from the import",
        s.detail.by ? String(s.detail.by) : null, s.detail.at ? String(s.detail.at) : null].filter(Boolean).join(" · ")}</span>
      {s.detail.text && !String(s.title).endsWith(String(s.detail.text).slice(0, 140)) ? <q className={css.quote}>{String(s.detail.text)}</q> : null}
      {s.confidence ? <span className={css.conf} style={{ "--c": Number(s.confidence) } as React.CSSProperties} aria-label={`${Math.round(Number(s.confidence) * 100)}% sure`} /> : null}
    </span>
    <span className={css.qActions}>
      {showGroup && onOpen && s.channelId ? <button type="button" className={css.linkBtn} onClick={() => onOpen(s.channelId!)}>Open group</button> : null}
      {s.kind === "task" || s.kind === "approval" ? <PersonSelect label="Who does it" people={doers} value={who[s.id] ?? null} size="sm" placeholder="Who does it" onChange={(p) => setWho((m) => ({ ...m, [s.id]: p?.id ?? null }))} /> : null}
      <button type="button" className={css.ghostBtn} disabled={busy === s.id} onClick={() => void act(s, false)} data-dismiss="">Dismiss</button>
      <button type="button" className={css.primary} disabled={busy === s.id} onClick={() => void act(s, true)} data-accept="">{s.kind === "task" || s.kind === "approval" ? "Make task" : "Accept"}</button>
    </span>
  </li>)}</ul>;
}
