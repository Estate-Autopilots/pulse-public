"use client";
// UX-TASKS-2: responsibility domains, the pool, value, what a client project includes, and how Pulse names the work.
// The database decides who may do each of these; these controls only offer what the API says the viewer can do.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Check, Compass, FolderKanban, Hand, Inbox, Link2, Package, Plus, ShieldCheck, Sparkles, Undo2, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { hours } from "../create";
import { Modal, post } from "../records";
import { Avatar, styles } from "../ui";
import { Segmented } from "../kit";
import { KindChip, kindOf } from "../work-kind";
import type { Domain, Task, ReviewPolicy } from "./types";
import { Chip, PRIORITY, dueText, shortDay } from "./parts";
import { zoneDay } from "../lib/zone.mjs";
import { useOrgZone } from "../org-code";
import css from "./work-two.module.css";
import { DateField } from "../kit/date-field";
import { SelectField } from "../kit/select-field";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const first = (name: string | null | undefined) => String(name ?? "Someone").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
const URGENCY: Record<string, string> = { low: "Can wait", normal: "Normal", high: "Urgent" };

// ------------------------------------------------------------------------------------------------ the pool
export type PoolTask = Task & { bestFit?: { id: string; name: string; why: string; photoAt: string | null } | null; pooledAt: string | null; pooledBy: string | null; pooledById: string | null; pooledByPhotoAt: string | null; suggestionReason: string | null; suggestedMinutes: number | null; canClaim: boolean };
/** One task in the pool: its priority first, then urgency, estimate and where it is from; Claim takes it (the first wins).
 *  INTEGRITY (owner, 22 Oct 2026): pool tasks carry no value points. */
export function PoolRow({ task, today, highlight }: { task: PoolTask; today: string; highlight?: boolean }) {
  const zone = useOrgZone();
  const router = useRouter(); const [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const due = dueText(task, today);
  async function claim() {
    setBusy(true);
    try { await post(`work/pool/${task.id}/claim`, {}); setDone(true);
      notify({ id: "claim", tone: "success", title: "It’s yours", href: `/tasks/${task.id}`, message: "Find it under My tasks.", timeout: 4200 });
      setTimeout(() => router.refresh(), 500); }
    catch (e) { notify({ id: "claim", tone: "error", title: "Not claimed", message: msg(e) }); router.refresh(); } finally { setBusy(false); }
  }
  return <li className={css.poolRow} data-leaving={done ? "" : undefined} data-highlight={highlight ? "" : undefined}>
    <span className={css.value} title="Importance"><b>{PRIORITY[task.priority]}</b><small>priority</small></span>
    <div className={css.poolMain}>
      <Link href={`/tasks/${task.id}`} className={css.poolTitle}>{task.title}</Link>
      <span className={css.meta}>
        {task.inDomain ? <Chip tone="accent" title={task.inDomain.title}><Compass size={11} />In your domain</Chip> : null}
        {task.urgency === "high" || task.priority === "urgent" ? <Chip tone="late">{task.urgency === "high" ? "Urgent" : "Urgent priority"}</Chip> : task.priority === "high" ? <Chip tone="warning">High priority</Chip> : null}
        {task.estimateMinutes ? <Chip>About {hours(task.estimateMinutes)}</Chip> : task.suggestedMinutes ? <Chip title="Pip's estimate">About {hours(task.suggestedMinutes)}</Chip> : null}
        {due ? <Chip tone={due.late ? "late" : undefined}>{due.text}</Chip> : null}
        {task.projectName ? <Chip><FolderKanban size={11} />{task.projectName}</Chip> : null}
        <Chip><Inbox size={11} />{task.poolScope === "company" ? "Company" : task.poolRef}</Chip>
      </span>
      {task.bestFit ? <span className={css.from} title={task.bestFit.why}><Avatar name={task.bestFit.name} id={task.bestFit.id} photoAt={task.bestFit.photoAt} size={18} />Best fit: <b>{first(task.bestFit.name)}</b> · {task.bestFit.why}</span> : null}
      {task.pooledBy ? <span className={css.from}><Avatar name={task.pooledBy} id={task.pooledById ?? undefined} photoAt={task.pooledByPhotoAt} size={18} />{first(task.pooledBy)} put it here{task.pooledAt ? ` · ${shortDay(zoneDay(zone, task.pooledAt))}` : ""}</span> : null}
    </div>
    <span className={css.poolEnd}>{done ? <span className={css.done}><Check size={13} aria-hidden="true" />Yours</span>
      : task.canClaim ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={claim}><Hand size={13} aria-hidden="true" />Claim</button>
      : <span className={styles.muted}>For {task.poolRef}</span>}</span>
  </li>;
}
export function ReleaseButton({ taskId }: { taskId: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={styles.btn} disabled={busy} title="Give it back to the pool so someone else can claim it" onClick={async () => {
    setBusy(true); try { await post(`work/pool/${taskId}/release`, {}); notify({ id: "release", tone: "success", title: "Back in the pool", timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "release", tone: "error", title: "Still yours", message: msg(e) }); } finally { setBusy(false); } }}><Undo2 size={13} aria-hidden="true" />Hand back</button>;
}

// ------------------------------------------------------------------------------------------------ domains
type Options = { categories: { key: string; label: string }[]; pods: string[]; clients: { id: string; name: string }[]; projects: { id: string; name: string; kind: string }[] };
type DomainSuggestion = { title: string; categories: string[]; pod: string | null; evidence: string[] };
/** One domain: what it covers, how it was agreed (or that it is company policy), and the buttons the viewer has. */
export function DomainCard({ d, self }: { d: Domain; self: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [asking, setAsking] = useState<string | null>(null), [note, setNote] = useState(""), [done, setDone] = useState("");
  async function act(a: NonNullable<Domain["actions"]>[number]) {
    if (a.fields?.length && asking !== a.key) { setAsking(a.key); return; }
    setBusy(true);
    try { await post(a.path.replace(/^\/api\/v0\//, ""), a.fields?.length ? { note } : {}); setDone(a.done); router.refresh(); }
    catch (e) { notify({ id: `domain:${d.id}`, tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  const where = [d.pod ? `${d.pod}’s work` : null, d.clientName ? `client ${d.clientName}` : null, d.projectName ? `project ${d.projectName}` : null].filter(Boolean).join(" · ");
  const how = d.basis === "policy" ? `Company policy${d.effectiveFrom ? ` from ${shortDay(d.effectiveFrom)}` : ""}${d.proposedBy ? ` · set by ${first(d.proposedBy)}` : ""}`
    : d.status === "active" ? `Agreed ${d.agreedOn ? shortDay(d.agreedOn) : ""}${d.companyAgreedBy ? ` with ${first(d.companyAgreedBy)}` : ""}`
    : d.status === "proposed" ? `${d.proposedSide === "employee" ? (self ? "You proposed it" : `${first(d.proposedBy)} proposed it`) : `${first(d.proposedBy)} proposed it for the company`} · waiting for ${d.proposedSide === "employee" ? "the company" : self ? "you" : "them"}`
    : d.status === "ended" ? `Ended${d.endedBy ? ` by ${first(d.endedBy)}` : ""}${d.endNote ? `: ${d.endNote}` : ""}` : d.status === "declined" ? `Declined${d.answerNote ? `: ${d.answerNote}` : ""}` : "Withdrawn";
  return <li className={css.domain} data-status={d.status} data-basis={d.basis}>
    <span className={css.domainIcon} aria-hidden="true">{d.basis === "policy" ? <ShieldCheck size={16} /> : <Compass size={16} />}</span>
    <div className={css.domainMain}>
      <b>{d.title}</b>
      <span className={css.meta}>{d.basis === "policy" ? <Chip tone="warning">Company policy</Chip> : d.status === "active" ? <Chip tone="accent">Agreed</Chip> : d.status === "proposed" ? <Chip>Proposed</Chip> : <Chip>{d.status[0].toUpperCase() + d.status.slice(1)}</Chip>}
        {d.categoryLabels.map((c) => <Chip key={c}>{c}</Chip>)}{d.tags.map((t) => <Chip key={t}>#{t}</Chip>)}{where ? <span>{where}</span> : null}</span>
      <small>{how}{d.note ? ` · “${d.note}”` : ""}</small>
    </div>
    <span className={css.domainActions}>{done ? <span className={css.done}><Check size={13} aria-hidden="true" />{done}</span> : <>
      {asking ? <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={d.actions?.find((a) => a.key === asking)?.fields?.[0]?.label ?? "Note"} aria-label="Note" autoFocus maxLength={500} /> : null}
      {(d.actions ?? []).map((a) => <button key={a.key} type="button" className={`${styles.btn}${a.tone === "primary" ? ` ${styles.btnPrimary}` : ""}`} disabled={busy} onClick={() => act(a)}>{asking === a.key ? `${a.label} now` : a.label}</button>)}
      {asking ? <button type="button" className={styles.iconBtn} aria-label="Cancel" onClick={() => setAsking(null)}><X size={13} aria-hidden="true" /></button> : null}
    </>}</span>
  </li>;
}

/** Propose a domain (the person for themselves, or someone speaking for the company), or set company policy. */
export function ProposeDomain({ personId, personName, self, canPolicy, options, prefill, label }: { personId: string; personName: string; self: boolean; canPolicy: boolean; options: Options; prefill?: DomainSuggestion; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [cats, setCats] = useState<string[]>(prefill?.categories ?? []), [pod, setPod] = useState(prefill?.pod ?? ""), [where, setWhere] = useState<"any" | "pod" | "client" | "project">(prefill?.pod ? "pod" : "any");
  const [client, setClient] = useState(""), [project, setProject] = useState(""), [title, setTitle] = useState(prefill?.title ?? ""), [touched, setTouched] = useState(!!prefill), [basis, setBasis] = useState<"agreement" | "policy">("agreement");
  const [note, setNote] = useState(""), [from, setFrom] = useState("");
  const catLabel = (k: string) => options.categories.find((c) => c.key === k)?.label ?? k;
  const auto = `${cats.length ? cats.map(catLabel).join(" and ") : "All work"}${where === "pod" && pod ? ` for ${pod} clients` : where === "client" && client ? ` for ${options.clients.find((c) => c.id === client)?.name ?? "a client"}` : where === "project" && project ? ` for ${options.projects.find((p) => p.id === project)?.name ?? "a project"}` : ""}`;
  const name = touched ? title : auto;
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { await post("work/domains", { personId, title: name, categories: cats, pod: where === "pod" ? pod : null, clientId: where === "client" ? client || null : null, projectId: where === "project" ? project || null : null, basis, note, effectiveFrom: from || null });
      notify({ id: "domain", tone: "success", title: basis === "policy" ? "Company policy set" : self ? "Proposed to the company" : `Proposed to ${first(personName)}`, message: basis === "policy" ? `${first(personName)} is told; it is active now.` : "The other side agrees or declines; it starts when both have.", timeout: 4200 });
      setOpen(false); router.refresh(); }
    catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  return <><button type="button" className={`${styles.btn}${prefill ? "" : ` ${styles.btnPrimary}`}`} onClick={() => setOpen(true)}><Plus size={13} aria-hidden="true" />{label ?? (self ? "Propose a domain" : "Propose a domain")}</button>
    {open ? <Modal title={self ? "Propose one of your domains" : `A domain for ${first(personName)}`} sub={basis === "policy" ? "Company policy is mandatory and active at once; the person is told." : "A responsibility both sides agree: work inside it is assigned to them directly, anything else is a request they accept or decline."} onClose={() => setOpen(false)}
      foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button form="domain-form" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || name.trim().length < 3}>{basis === "policy" ? "Set as company policy" : "Send the proposal"}</button></div>}>
      <form id="domain-form" onSubmit={save} className={css.domainForm}>
        {prefill ? <p className={css.formNote}>Suggested from their work: {prefill.evidence.join(" · ")}</p> : null}
        <fieldset className={css.fieldset}><legend>Kind of work</legend>
          <div className={css.choiceChips}>{options.categories.map((c) => <button key={c.key} type="button" aria-pressed={cats.includes(c.key)} onClick={() => setCats(cats.includes(c.key) ? cats.filter((x) => x !== c.key) : [...cats, c.key])}>{c.label}</button>)}</div>
        </fieldset>
        <fieldset className={css.fieldset}><legend>Where</legend>
          <div className={css.choiceChips} role="radiogroup">{([["any", "Anywhere"], ["pod", "A pod’s clients"], ["client", "One client"], ["project", "One project"]] as const).map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={where === k} onClick={() => setWhere(k)}>{l}</button>)}</div>
          {where === "pod" ? <SelectField value={pod} onChange={(e) => setPod(e.target.value)} aria-label="Pod"><option value="">Choose a pod</option>{options.pods.map((p) => <option key={p}>{p}</option>)}</SelectField> : null}
          {where === "client" ? <SelectField value={client} onChange={(e) => setClient(e.target.value)} aria-label="Client"><option value="">Choose a client</option>{options.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField> : null}
          {where === "project" ? <SelectField value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project"><option value="">Choose a project</option>{options.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField> : null}
        </fieldset>
        <label className={styles.field}>Name<input value={name} onChange={(e) => { setTitle(e.target.value); setTouched(true); }} maxLength={160} placeholder="e.g. Video editing for Pod 2 clients" /></label>
        {canPolicy ? <div className={css.choiceChips} role="radiogroup" aria-label="Basis">
          <button type="button" role="radio" aria-checked={basis === "agreement"} onClick={() => setBasis("agreement")}>Agreed with {first(personName)}</button>
          <button type="button" role="radio" aria-checked={basis === "policy"} onClick={() => setBasis("policy")}><ShieldCheck size={13} aria-hidden="true" />Company policy</button></div> : null}
        <div className={css.twoCols}><label className={styles.field}>Starts<DateField value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className={styles.field}>A line (optional)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={self ? "I have done these for six months" : "You already run these"} /></label></div>
        {error ? <p role="alert" className={css.error}>{error}</p> : null}
      </form>
    </Modal> : null}</>;
}

// ------------------------------------------------------------------------------------------------ what a client project includes
type Evidence = { kind: string; text: string; detail?: string };
export type LinkSuggestion = { id: string; source: string; confidence: number; evidence: Evidence[]; projectId: string; name?: string; projectName?: string; kind?: string; projectKind?: string; month?: string | null;
  projectMonth?: string | null; clientProjectId?: string; clientProjectName?: string; clientName?: string | null; clientProjectMonth?: string | null; tasks?: number };
/** A suggested link with its evidence: leadership links it or says it is not related, in one click. */
export function LinkSuggestionRow({ s, canDecide, showPackage }: { s: LinkSuggestion; canDecide: boolean; showPackage?: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [done, setDone] = useState("");
  async function decide(action: "link" | "dismiss") {
    setBusy(true);
    try { await post(`work/links/${s.id}/${action}`, {}); setDone(action === "link" ? "Linked" : "Not related"); router.refresh(); }
    catch (e) { notify({ id: `link:${s.id}`, tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  const kind = s.projectKind ?? s.kind;
  return <li className={css.linkRow} data-stacked={showPackage ? "" : undefined}>
    <div className={css.linkMain}>
      {showPackage ? <span className={css.linkPair}><KindChip kind="client" short /><Link href={`/projects/${s.clientProjectId}`} className={css.linkName}>{s.clientProjectName}</Link>{s.clientProjectMonth ? <small>{s.clientProjectMonth}</small> : null}</span> : null}
      <span className={css.linkPair}>
        {showPackage ? <span className={css.arrow}>includes</span> : null}
        <KindChip kind={kindOf(kind === "client_work" ? "client" : "internal")} short /><Link href={kind === "client_work" ? `/projects/${s.projectId}` : `/tasks/projects/${s.projectId}`} className={css.linkName}>{s.projectName ?? s.name}</Link>
        {(s.projectMonth ?? s.month) ? <small>{s.projectMonth ?? s.month}</small> : null}
        <span className={css.conf} title="How sure Pulse is, from the evidence">{Math.round(s.confidence * 100)}%</span>
      </span>
      <ul className={css.evidence}>{s.evidence.map((e, i) => <li key={i} title={e.detail}>{e.text}</li>)}</ul>
    </div>
    <span className={css.linkActions}>{done ? <span className={css.done}><Check size={13} aria-hidden="true" />{done}</span> : canDecide ? <>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => decide("link")}><Link2 size={13} aria-hidden="true" />Link</button>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => decide("dismiss")}>Not related</button></> : <span className={styles.muted}>Leadership decides</span>}</span>
  </li>;
}
/** Place a project under a client project by hand (leadership, or the project's owner for the company's own projects). */
export function PlaceUnder({ clientProjectId, label = "Add a project" }: { clientProjectId: string; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [q, setQ] = useState(""), [list, setList] = useState<{ id: string; name: string; kind: string; clientName: string | null }[] | null>(null), [busy, setBusy] = useState(false);
  async function load() {
    setOpen(true);
    if (!list) { const r = await fetch("/api/v0/work/projects?show=all").then((x) => x.json()).catch(() => null); setList((r?.rows ?? []).filter((p: { id: string }) => p.id !== clientProjectId)); }
  }
  async function place(id: string, name: string) {
    setBusy(true);
    try { await post("work/links", { clientProjectId, projectId: id, on: true }); notify({ id: "place", tone: "success", title: `${name} is now part of it`, timeout: 3000 }); setOpen(false); router.refresh(); }
    catch (e) { notify({ id: "place", tone: "error", title: "Not placed", message: msg(e) }); } finally { setBusy(false); }
  }
  const shown = (list ?? []).filter((p) => !q || `${p.name} ${p.clientName ?? ""}`.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return <><button type="button" className={styles.btn} onClick={load}><Plus size={13} aria-hidden="true" />{label}</button>
    {open ? <Modal title="Place a project under this one" sub="The company’s own projects, or another client project folder that belongs to this package." onClose={() => setOpen(false)}>
      <input className={styles.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects" aria-label="Search projects" autoFocus />
      {list ? <ul className={css.pickList}>{shown.map((p) => <li key={p.id}><button type="button" disabled={busy} onClick={() => place(p.id, p.name)}><KindChip kind={kindOf(p.kind)} short />{p.name}{p.clientName ? <small>{p.clientName}</small> : null}</button></li>)}</ul> : <p className={styles.muted}>Loading…</p>}
    </Modal> : null}</>;
}
export function DetectLinks() {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={styles.btn} disabled={busy} onClick={async () => {
    setBusy(true); try { const r = await post<{ suggested: number; retired: number; pending: number }>("work/links/detect", {}); notify({ id: "detect", tone: "success", title: r.suggested ? `${r.suggested} new suggestions` : "Nothing new", message: `${r.pending} waiting for a decision`, timeout: 3500 }); router.refresh(); }
    catch (e) { notify({ id: "detect", tone: "error", title: "Not checked", message: msg(e) }); } finally { setBusy(false); } }}><Package size={13} aria-hidden="true" />Look again</button>;
}

// ------------------------------------------------------------------------------------------------ how Pulse names the work
type Settings = { businessModel: "agency" | "product" | "internal"; aiAutoAcceptMax: number | null; teamLabel?: string; canEdit: boolean; updatedBy: string | null; updatedAt: string | null;
  models: Record<string, { label: string; hint: string }>; labels: { section: string | null; clientProjects: string | null; clients: string | null; packageChip: string; fulfilmentChip: string } } & ReviewPolicy;
/** The kind of business (names Clients, Client projects, Releases…) and Pip's low-value automatic acceptance. */
export function WorkModel({ data }: { data: Settings }) {
  const router = useRouter(); const [model, setModel] = useState(data.businessModel), [busy, setBusy] = useState(false);
  async function save(body: Record<string, unknown>, ok: string) {
    setBusy(true); try { await post("work/settings", body); notify({ id: "work-model", tone: "success", title: ok, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "work-model", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  const words = (m: string) => m === "product" ? "Products → Releases, Customers" : m === "internal" ? "No clients: the company’s own projects only" : "Clients → Client projects (packages or engagements)";
  return <section className={css.model} aria-labelledby="model-title">
    <header><h2 id="model-title">How Pulse names your work</h2><p>The kind of business decides what the rail and every page call clients and what was sold. {data.canEdit ? "Leadership and admins change it." : "Leadership and admins change it."}</p></header>
    <div className={css.models} role="radiogroup" aria-label="Kind of business">{Object.entries(data.models).map(([k, m]) => <button key={k} type="button" role="radio" aria-checked={model === k} disabled={!data.canEdit || busy}
      onClick={() => { setModel(k as Settings["businessModel"]); void save({ businessModel: k }, `Pulse now speaks ${m.label.toLowerCase()}`); }}>
      <b>{m.label}</b><small>{m.hint}</small><em>{words(k)}</em></button>)}</div>
    <TeamWord value={data.teamLabel ?? "Pod"} canEdit={data.canEdit} onSave={(teamLabel) => save({ teamLabel }, `A team is now called a ${teamLabel.toLowerCase()}`)} busy={busy} />
    {data.updatedBy ? <p className={css.formNote}>Last changed by {data.updatedBy}.</p> : null}
  </section>;
}
/** TASKS-4A: pods are the company's teams; this is the word everyone sees for one (Pod, Team, Squad…). */
function TeamWord({ value, canEdit, onSave, busy }: { value: string; canEdit: boolean; onSave: (v: string) => void; busy: boolean }) {
  const [other, setOther] = useState(["Pod", "Team", "Squad", "Crew"].includes(value) ? "" : value);
  const presets = ["Pod", "Team", "Squad", "Crew"] as const;
  return <div className={css.autoRow} role="group" aria-label="What a team is called" style={{ flexWrap: "wrap", alignItems: "center", gap: "8px 16px" }}>
    <span style={{ flex: "1 1 280px", display: "grid", gap: 2 }}><b>What you call a team</b><small>Pods are your teams: scopes, dashboards and pickers use this word. EA says Pod.</small></span>
    <Segmented label="Word for a team" size="sm" value={(presets as readonly string[]).includes(value) ? value : ""} options={presets.map((w) => ({ value: w, label: w, disabled: !canEdit || busy }))}
      onChange={(w) => { setOther(""); onSave(w); }} />
    <label className={css.limit}>or<input value={other} maxLength={20} placeholder="Another word" disabled={!canEdit || busy} onChange={(e) => setOther(e.target.value)} onBlur={() => { if (other.trim().length >= 2 && other.trim() !== value) onSave(other.trim()); }} aria-label="Another word for a team" style={{ width: 120 }} /></label>
  </div>;
}
