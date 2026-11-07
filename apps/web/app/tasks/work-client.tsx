"use client";
// Collaboration on tasks and projects (UX-TASKS): asks that the other person accepts or declines, following, people on
// a project, a discussion with @mentions, and leadership's one-click filing of projects the migration could not place.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { Bell, BellOff, Check, FolderKanban, Hand, Package, Pencil, Plus, UserPlus, Users, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { openCreate, PersonPicker, type Options, type Person } from "../create";
import { Modal, post } from "../records";
import { Avatar, styles } from "../ui";
import { Rating, Toggle } from "./kit";
import css from "./tasks.module.css";
import { DateField } from "../kit/date-field";
import { SelectField } from "../kit/select-field";
import { useOrgCode } from "../org-code";
import { registryId } from "../lib/format";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const first = (name: string | null | undefined) => String(name ?? "Someone").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
let staff: Promise<Options> | null = null;
/** Everyone, with who the viewer may assign directly: read once per page view. */
export function useStaff(open: boolean) {
  const [o, setO] = useState<Options | null>(null);
  useEffect(() => { if (!open || o) return; staff ??= fetch("/api/v0/work/options").then((r) => r.json()); staff.then(setO).catch(() => { staff = null; }); }, [open, o]);
  return o;
}

export function NewProjectButton() {
  return <button type="button" className={styles.btn} onClick={() => openCreate({ kind: "project" })}><Plus size={14} aria-hidden="true" />New project</button>;
}
export function NewTaskButton({ projectId, parentId, label = "Add task", primary }: { projectId?: string; parentId?: string; label?: string; primary?: boolean }) {
  return <button type="button" className={`${styles.btn}${primary ? ` ${styles.btnPrimary}` : ""}`} onClick={() => openCreate({ kind: "task", projectId, parentId })}><Plus size={14} aria-hidden="true" />{label}</button>;
}
export function SetUpButton({ clientProjectId, label = "Set up the fulfilment" }: { clientProjectId: string; label?: string }) {
  return <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => openCreate({ kind: "project", clientProjectId })}><Package size={14} aria-hidden="true" />{label}</button>;
}

// ------------------------------------------------------------------------------------------------ asks
export type Ask = { id: string; kind: "take" | "invite" | "join"; status: string; note: string | null; title: string; incoming: boolean; fromId: string; fromName: string; fromPhotoAt: string | null;
  toId: string; toName: string; createdAt: string; actions: { key: string; label: string; path: string; tone: string }[] };
/** A request on this task or project: the person asked answers here; the sender can withdraw. */
export function AskBanner({ ask, highlight }: { ask: Ask; highlight?: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState(""), [declining, setDeclining] = useState(false), [busy, setBusy] = useState(false), [done, setDone] = useState("");
  async function act(key: string) {
    const a = ask.actions.find((x) => x.key === key); if (!a) return;
    setBusy(true);
    try { await post(a.path.replace(/^\/api\/v0\//, ""), key === "decline" ? { note } : {}); setDone(key === "accept" ? (ask.kind === "take" ? "It’s yours" : "Accepted") : key === "decline" ? "Declined" : "Withdrawn"); router.refresh(); }
    catch (e) { notify({ id: `ask:${ask.id}`, tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  return <div className={css.ask} data-incoming={ask.incoming ? "" : undefined} data-highlight={highlight ? "" : undefined} role={ask.incoming ? "alert" : undefined}>
    <Avatar name={ask.incoming ? ask.fromName : ask.toName} id={ask.incoming ? ask.fromId : ask.toId} photoAt={ask.incoming ? ask.fromPhotoAt : null} size={32} />
    <div className={css.askMain}><b>{ask.title}</b>{ask.note ? <span>“{ask.note}”</span> : <span>{ask.incoming ? (ask.kind === "take" ? "Taking it makes it yours, and they review it when you are done." : "Accept to see and work on it with them.") : "Waiting for their answer."}</span>}</div>
    {done ? <span className={css.askDone}><Check size={14} aria-hidden="true" />{done}</span> : ask.incoming ? <div className={css.askActions}>
      {declining ? <form onSubmit={(e) => { e.preventDefault(); void act("decline"); }} className={css.inlineForm}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="A short reason (optional)" maxLength={500} aria-label="Reason for declining" autoFocus />
        <button className={styles.btn} disabled={busy}>Decline</button><button type="button" className={styles.btn} onClick={() => setDeclining(false)}>Back</button></form>
        : <><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => act("accept")}><Check size={13} aria-hidden="true" />{ask.actions.find((a) => a.key === "accept")?.label ?? "Accept"}</button>
          <button type="button" className={styles.btn} disabled={busy} onClick={() => setDeclining(true)}>Decline</button></>}
    </div> : ask.actions.some((a) => a.key === "withdraw") ? <button type="button" className={styles.btn} disabled={busy} onClick={() => act("withdraw")}>Withdraw</button> : null}
  </div>;
}

/** "Ask someone to take it" (a task) or "Invite to join" (a task or project): pick a person, add a line, send. */
export function AskSomeone({ kind, taskId, projectId, label, exclude = [] }: { kind: "take" | "invite"; taskId?: string; projectId?: string; label?: string; exclude?: string[] }) {
  const [open, setOpen] = useState(false);
  const text = label ?? (kind === "take" ? "Ask someone to take it" : "Invite someone");
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}>{kind === "take" ? <Hand size={13} aria-hidden="true" /> : <UserPlus size={13} aria-hidden="true" />}{text}</button>
    {open ? <AskDialog kind={kind} taskId={taskId} projectId={projectId} exclude={exclude} onClose={() => setOpen(false)} /> : null}</>;
}
export function AskDialog({ kind, taskId, projectId, exclude = [], onClose }: { kind: "take" | "invite"; taskId?: string; projectId?: string; exclude?: string[]; onClose: () => void }) {
  const router = useRouter();
  const [who, setWho] = useState<Person | null>(null), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const o = useStaff(true);
  const people = (o?.people ?? []).filter((p) => p.id !== o?.me && !exclude.includes(p.id));
  async function send(e: FormEvent) {
    e.preventDefault(); if (!who) return; setBusy(true);
    try { await post("work/asks", { kind, taskId, projectId, toId: who.id, note }); notify({ id: "ask", tone: "success", title: `Asked ${first(who.name)}`, message: "They accept or decline; you hear their answer.", timeout: 3500 }); onClose(); router.refresh(); }
    catch (err) { notify({ id: "ask", tone: "error", title: "Not sent", message: msg(err) }); } finally { setBusy(false); }
  }
  return <Modal title={kind === "take" ? "Ask someone to take this" : "Invite someone to join"} sub={kind === "take" ? "They get a request with Accept and Decline. If they accept, it is theirs and you review it." : "They get an invitation with Accept and Decline."} onClose={onClose}
      foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={onClose}>Cancel</button><button form="ask-form" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !who}>{who ? `Send to ${first(who.name)}` : "Send"}</button></div>}>
      <form id="ask-form" onSubmit={send} className={css.askForm}>
        {o ? <PersonPicker people={people} value={who} onChange={setWho} me={o.me} label="Who" /> : <p className={styles.muted}>Loading people…</p>}
        <label className={styles.field}>A line for them (optional)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={kind === "take" ? "You know this client best" : "We could use your eye on this"} /></label>
      </form>
    </Modal>;
}
export function AskToJoin({ taskId, projectId, label = "Ask to join" }: { taskId?: string; projectId?: string; label?: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={styles.btn} disabled={busy} onClick={async () => {
    setBusy(true);
    try { await post("work/asks", { kind: "join", taskId, projectId }); notify({ id: "join", tone: "success", title: "Asked to join", message: "The owner accepts or declines; you hear their answer.", timeout: 3500 }); router.refresh(); }
    catch (e) { notify({ id: "join", tone: "error", title: "Not sent", message: msg(e) }); } finally { setBusy(false); }
  }}><UserPlus size={13} aria-hidden="true" />{label}</button>;
}
export function WatchButton({ taskId, projectId, watching }: { taskId?: string; projectId?: string; watching: boolean }) {
  const router = useRouter(); const [on, setOn] = useState(watching), [busy, setBusy] = useState(false);
  return <button type="button" className={styles.btn} aria-pressed={on} disabled={busy} title={on ? "You hear when it starts, blocks, finishes or gets a comment" : "Follow: hear when it starts, blocks, finishes or gets a comment"}
    onClick={async () => { setBusy(true); try { await post("work/watch", { taskId, projectId, on: !on }); setOn(!on); router.refresh(); } catch (e) { notify({ id: "watch", tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); } }}>
    {on ? <BellOff size={13} aria-hidden="true" /> : <Bell size={13} aria-hidden="true" />}{on ? "Following" : "Follow"}</button>;
}

/** People on a project: owner, members, followers. Managers add (inside their reach) or invite (outside it), or remove. */
export function ProjectPeople({ projectId, owner, members, canManage, onIt }: { projectId: string; owner: { id: string | null; name: string | null; photoAt: string | null }; members: { id: string; name: string; role: string; photoAt: string | null; pod?: string | null }[]; canManage: boolean; onIt: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [picked, setPicked] = useState<Person[]>([]), [busy, setBusy] = useState(false);
  const o = useStaff(open);
  const taken = new Set([owner.id, ...members.filter((m) => m.role === "member").map((m) => m.id)]);
  async function save(add: string[], remove: string[]) {
    setBusy(true);
    try { const r = await post<{ added: number; invited: number; removed: number }>(`work/projects/${projectId}/people`, { add, remove });
      notify({ id: "people", tone: "success", title: [r.added ? `${r.added} added` : "", r.invited ? `${r.invited} invited` : "", r.removed ? `${r.removed} removed` : ""].filter(Boolean).join(" · ") || "No change", message: r.invited ? "Invited people accept or decline." : undefined, timeout: 3000 });
      setOpen(false); setPicked([]); router.refresh(); }
    catch (e) { notify({ id: "people", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  const team = members.filter((m) => m.role === "member"), followers = members.filter((m) => m.role === "watcher");
  return <div className={css.peopleBlock}>
    <ul className={css.peopleList}>
      {owner.id ? <li><Avatar name={owner.name ?? "Owner"} id={owner.id} photoAt={owner.photoAt} size={28} status /><span>{owner.name}<small>Owner</small></span></li> : <li className={styles.muted}>No owner yet</li>}
      {team.map((m) => <li key={m.id}><Avatar name={m.name} id={m.id} photoAt={m.photoAt} size={28} status /><span>{m.name}<small>{m.pod ?? "Member"}</small></span>
        {canManage ? <button type="button" className={styles.iconBtn} aria-label={`Remove ${m.name}`} title="Remove from the project" disabled={busy} onClick={() => save([], [m.id])}><X size={13} aria-hidden="true" /></button> : null}</li>)}
    </ul>
    {followers.length ? <p className={css.note}>Following: {followers.map((f) => first(f.name)).join(", ")}</p> : null}
    {canManage || onIt ? <button type="button" className={styles.btn} onClick={() => setOpen(true)}><Users size={13} aria-hidden="true" />{canManage ? "Add people" : "Invite someone"}</button> : null}
    {open ? <Modal title="Add people to this project" sub="People inside your reach join at once and are told. Anyone else gets an invitation to accept." onClose={() => setOpen(false)}
      foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !picked.length} onClick={() => save(picked.map((p) => p.id), [])}>Add {picked.length || ""}</button></div>}>
      <div className={css.askForm}>
        <div className={css.pickedRow}>{picked.map((p) => <span key={p.id} className={css.picked}><Avatar name={p.name} id={p.id} photoAt={p.photoAt ?? null} size={20} />{first(p.name)}{p.canAssign === false ? <em>invite</em> : null}
          <button type="button" aria-label={`Remove ${p.name}`} onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}><X size={11} aria-hidden="true" /></button></span>)}</div>
        {o ? <PersonPicker people={o.people.filter((p) => !taken.has(p.id) && !picked.some((x) => x.id === p.id))} value={null} onChange={(p) => p && setPicked([...picked, p])} me={o.me} label="Add a person" showAsk /> : <p className={styles.muted}>Loading people…</p>}
      </div>
    </Modal> : null}
  </div>;
}

/** Owner, dates, status and summary of a work project (and the name of an internal one). */
export function EditProject({ projectId, kind, name, ownerId, startsOn, dueOn, status, summary }: { projectId: string; kind: string; name: string; ownerId: string | null; startsOn: string | null; dueOn: string | null; status: string; summary: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const o = useStaff(open); const [picked, setOwner] = useState<Person | null | undefined>(undefined);
  const owner = picked === undefined ? o?.people.find((p) => p.id === ownerId) ?? null : picked;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError("");
    try { await post(`work/projects/${projectId}`, { ...(kind === "internal" ? { name: f.get("name") } : {}), ownerId: owner?.id ?? null, startsOn: f.get("startsOn") || null, dueOn: f.get("dueOn") || null, status: f.get("status"), summary: f.get("summary") });
      setOpen(false); router.refresh(); } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}><Pencil size={13} aria-hidden="true" />Edit</button>
    {open ? <Modal title="Edit project" onClose={() => setOpen(false)} foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button form="project-edit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>Save</button></div>}>
      <form id="project-edit" onSubmit={save} className={css.askForm}>
        {kind === "internal" ? <label className={styles.field}>Name<input name="name" defaultValue={name} required minLength={2} maxLength={200} /></label> : null}
        <div className={styles.field}><span>Owner</span>{o ? <PersonPicker people={o.people} value={owner} onChange={setOwner} me={o.me} label="Owner" /> : <span className={styles.muted}>Loading…</span>}</div>
        <div className={css.twoFields}><label className={styles.field}>Start<DateField name="startsOn" defaultValue={startsOn ?? ""} /></label><label className={styles.field}>Due<DateField name="dueOn" defaultValue={dueOn ?? ""} /></label></div>
        <label className={styles.field}>Status<SelectField name="status" defaultValue={status}>{[["planned", "Planned"], ["active", "Active"], ["paused", "Paused"], ["done", "Done"], ["cancelled", "Cancelled"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField></label>
        <label className={styles.field}>What it is for (one or two lines)<textarea name="summary" defaultValue={summary ?? ""} maxLength={1000} className={styles.input} style={{ height: 72, paddingTop: 6 }} /></label>
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </form>
    </Modal> : null}</>;
}

// ------------------------------------------------------------------------------------------------ discussion
export type Comment = { id: string; body: string; at: string; authorId: string; authorName: string; authorPhotoAt: string | null; mine: boolean; people: { id: string; name: string; photoAt?: string | null }[];
  /** TASKS-4B: threads, help requests and resolved threads; the people who answered a help request (with the viewer's own rating). */
  parentId?: string | null; kind?: "comment" | "help"; resolvedAt?: string | null; resolvedBy?: string | null; helpers?: { id: string; name: string; photoAt: string | null; rating: number | null }[] | null };
// ------------------------------------------------------------------------------------------------ filing review
type ReviewItem = { id: string; reason: string; detail: { tasks?: number; suggestedClientId?: string; suggestedClient?: string; client?: string; kind?: string }; projectId: string; name: string; registryNo: number; kind: string; hasDrive: boolean; clientName: string | null; tasks: number };
/** One project the migration did not guess about: a client package without a client (or a kind that disagrees with its
 *  client). Leadership answers in one click; Pulse keeps the answer. */
export function ReviewRow({ row, clients, canDecide }: { row: ReviewItem; clients: { id: string; name: string }[]; canDecide: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [done, setDone] = useState(""), [picking, setPicking] = useState(false), [q, setQ] = useState("");
  async function decide(decision: "client" | "internal", clientId?: string, label?: string) {
    setBusy(true);
    try { await post(`work/review/${row.id}`, { decision, clientId }); setDone(label ?? (decision === "internal" ? "Filed as internal work" : "Kept as a client package")); setPicking(false); router.refresh(); }
    catch (e) { notify({ id: `review:${row.id}`, tone: "error", title: "Not filed", message: msg(e) }); } finally { setBusy(false); }
  }
  const list = clients.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  const orgCode = useOrgCode();
  return <li className={css.row} style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
    <div className={css.rowMain}>
      <span className={css.projectTop}><Link className={css.title} href={`/projects/${row.projectId}`}>{row.name}</Link></span>
      <span className={css.meta}>{registryId(row.registryNo, orgCode)}{row.tasks ? ` · ${row.tasks} tasks` : ""}{row.hasDrive ? " · Drive folder" : ""}
        {row.reason === "client_kind" ? ` · filed as ${row.kind === "internal" ? "internal" : "a client package"} under ${row.detail.client}` : " · no client linked"}</span>
      {done ? <span className={css.askDone}><Check size={13} aria-hidden="true" />{done}</span> : canDecide ? <span className={css.decide}>
        {row.detail.suggestedClientId ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => decide("client", row.detail.suggestedClientId, `Linked to ${row.detail.suggestedClient}`)}>Link to {row.detail.suggestedClient}</button> : null}
        <button type="button" className={styles.btn} disabled={busy} onClick={() => setPicking(!picking)}>{row.detail.suggestedClientId ? "Other client" : "Pick client"}</button>
        {row.reason === "no_client" ? <button type="button" className={styles.btn} disabled={busy} onClick={() => decide("client")} title="Keep it a client package; link the client later">Keep, link later</button> : <button type="button" className={styles.btn} disabled={busy} onClick={() => decide("client")}>Client package</button>}
        <button type="button" className={styles.btn} disabled={busy} onClick={() => decide("internal")}><FolderKanban size={13} aria-hidden="true" />Internal</button>
      </span> : <span className={styles.muted}>Leadership decides.</span>}
      {picking ? <div className={css.clientPick}><input className={styles.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients" aria-label="Search clients" autoFocus />
        <ul>{list.map((c) => <li key={c.id}><button type="button" disabled={busy} onClick={() => decide("client", c.id, `Linked to ${c.name}`)}>{c.name}</button></li>)}</ul></div> : null}
    </div>
  </li>;
}

// ------------------------------------------------------------------------------------------------ client package
export function EditPackage({ id, scope, startsOn, endsOn, status, value }: { id: string; scope: string | null; startsOn: string | null; endsOn: string | null; status: string; value: { amount: number; currency: string } | null }) {
  const router = useRouter(); const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError("");
    try { await post(`work/package/${id}`, { scope: f.get("scope"), startsOn: f.get("startsOn") || null, endsOn: f.get("endsOn") || null, status: f.get("status"), valueAmount: f.get("valueAmount") });
      setOpen(false); router.refresh(); } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}><Pencil size={13} aria-hidden="true" />Edit package</button>
    {open ? <Modal title="Client package" sub="What the client bought. Leadership and admins edit it; the value is visible to them only." onClose={() => setOpen(false)}
      foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button form="package-edit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>Save</button></div>}>
      <form id="package-edit" onSubmit={save} className={css.askForm}>
        <label className={styles.field}>Scope<textarea name="scope" defaultValue={scope ?? ""} maxLength={2000} className={styles.input} style={{ height: 80, paddingTop: 6 }} placeholder="e.g. 4 model videos and 12 creatives a month, Meta ads" /></label>
        <div className={css.twoFields}><label className={styles.field}>Starts<DateField name="startsOn" defaultValue={startsOn ?? ""} /></label><label className={styles.field}>Ends<DateField name="endsOn" defaultValue={endsOn ?? ""} /></label></div>
        <div className={css.twoFields}><label className={styles.field}>Value (INR)<input name="valueAmount" inputMode="decimal" defaultValue={value ? String(value.amount) : ""} placeholder="0" /></label>
          <label className={styles.field}>Status<SelectField name="status" defaultValue={status}>{["onboarding", "active", "paused", "done", "cancelled"].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</SelectField></label></div>
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </form>
    </Modal> : null}</>;
}

// ------------------------------------------------------------------------------------------------ notification cards
/** The card contract of GET /api/v0/work/notices (for the notification panel): render the actions a card offers.
 *  `fields` become inputs (a choice is the kit's Rating, a flag a switch, text a short line); `body` is sent with them. */
export type NoticeCard = { id: string; eventType: string; state: string; from?: { id: string; name: string; photoAt?: string | null } | null; actions: { key: string; label: string; tone: string; method: "POST"; path: string; body?: Record<string, unknown>;
  fields?: { key: string; label: string; type: "text" | "choice" | "flag"; default?: number | string; options?: { value: string; label: string }[] }[]; done: string }[] };
export function CardActions({ card }: { card: NoticeCard }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string | number>>({}), [open, setOpen] = useState<string | null>(null), [busy, setBusy] = useState(false), [done, setDone] = useState("");
  if (done) return <span className={css.askDone}><Check size={13} aria-hidden="true" />{done}</span>;
  if (card.state !== "open") return card.state === "accepted" || card.state === "declined" || card.state === "withdrawn" ? <span className={styles.muted}>{card.state[0].toUpperCase() + card.state.slice(1)}</span> : null;
  async function run(a: NoticeCard["actions"][number]) {
    const fields = Object.fromEntries((a.fields ?? []).map((f) => [f.key, f.type === "flag" ? !!Number(values[`${a.key}:${f.key}`] ?? f.default ?? 0) : values[`${a.key}:${f.key}`] ?? f.default ?? ""]));
    if (a.fields?.some((f) => f.type === "text") && open !== a.key && a.key !== "decline") { setOpen(a.key); return; }
    setBusy(true);
    try { await post(a.path.replace(/^\/api\/v0\//, ""), { ...(a.body ?? {}), ...fields }); setDone(a.done); router.refresh(); }
    catch (e) { notify({ id: `card:${card.id}`, tone: "error", title: "Not done", message: msg(e) }); } finally { setBusy(false); }
  }
  return <span className={css.inlineForm} style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
    {card.actions.map((a) => <Fragment key={a.key}>
      {(a.fields ?? []).filter((f) => f.type === "choice").map((f) => <Rating key={f.key} label={f.label} options={f.options ?? []} value={String(values[`${a.key}:${f.key}`] ?? f.default ?? "")} size="sm" hideLabel
        onChange={(v) => setValues({ ...values, [`${a.key}:${f.key}`]: v })} />)}
      {(a.fields ?? []).filter((f) => f.type === "flag").map((f) => <Toggle key={f.key} label={f.label} checked={!!Number(values[`${a.key}:${f.key}`] ?? f.default ?? 0)} onChange={(on) => setValues({ ...values, [`${a.key}:${f.key}`]: on ? 1 : 0 })} />)}
      {open === a.key ? (a.fields ?? []).filter((f) => f.type === "text").map((f) => <input key={f.key} aria-label={f.label} placeholder={f.label} value={String(values[`${a.key}:${f.key}`] ?? "")} autoFocus
        onChange={(e) => setValues({ ...values, [`${a.key}:${f.key}`]: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void run(a); } }} />) : null}
      <button type="button" className={`${styles.btn}${a.tone === "primary" ? ` ${styles.btnPrimary}` : ""}`} disabled={busy} onClick={() => open === a.key ? run({ ...a, fields: a.fields }) : run(a)}>{a.label}</button>
    </Fragment>)}
  </span>;
}
