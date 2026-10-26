"use client";
// One joining or leaving case: each step says what Pulse found in the data and what it proposes; HR confirms (or
// changes) it with one click. A step is done when the data says so, or when HR confirms or skips it with a reason.
import { Check, SkipForward } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { day, dayYear, plural } from "../../lib/format";
import { post } from "../../records";
import { styles } from "../../ui";
import { LEFT_LABEL, STEP_LABEL, type Brief, type CaseView, type LeftType, type Step } from "./types";
import css from "./moves.module.css";

type Proposal = Record<string, unknown>;
type Item = { id: string; title?: string; name?: string; status?: string; dueAt?: string | null; project?: string | null; claimed?: boolean; to?: Brief | null; kind?: string };
const arr = <T,>(v: unknown) => (Array.isArray(v) ? v : []) as T[];
const num = (v: unknown) => typeof v === "number" ? v : v === null || v === undefined ? null : Number(v);

function PersonSelect({ value, onChange, people, label, pool }: { value: string; onChange: (v: string) => void; people: Brief[]; label: string; pool?: boolean }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
    <option value="">{pool ? "Back to the pool" : "Choose…"}</option>
    {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.pod ? ` · ${p.pod}` : ""}</option>)}
  </select>;
}

function StepCard({ c, s, children, run, busy }: { c: CaseView; s: Step; children: ReactNode; run: (key: string, body: Proposal) => Promise<void>; busy: boolean }) {
  const [skipping, setSkipping] = useState(false), [why, setWhy] = useState("");
  const label = STEP_LABEL[s.key] ?? { title: s.key, line: "" };
  const state = s.status === "done" ? (s.auto ? "Already done" : `Done${s.doneBy ? ` by ${s.doneBy}` : ""}${s.doneAt ? `, ${day(s.doneAt)}` : ""}`)
    : s.status === "skipped" ? `Skipped${s.note ? `: ${s.note}` : ""}` : s.pending > 1 && !["settlement", "assets", "alumni"].includes(s.key) ? `${s.pending} to do` : "To do";
  return <li><details className={css.step} data-status={s.status} data-step={s.key} open={s.status === "todo"}>
    <summary><span className={css.mark} aria-hidden="true">{s.status === "done" ? <Check size={14} /> : s.status === "skipped" ? <SkipForward size={12} /> : c.steps.indexOf(s) + 1}</span>
      <span className={css.title}><b>{label.title}</b><small>{label.line}</small></span><small className={css.sub}>{state}</small></summary>
    <div className={css.body}>{children}
      {c.canAct && s.status === "todo" && s.key !== "alumni" ? (skipping ? <div className={css.bar}>
        <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why this step is skipped" aria-label="Why this step is skipped" maxLength={500} style={{ flex: "1 1 240px", minHeight: 32, padding: "0 8px", border: "1px solid var(--theme-border)", borderRadius: 8, background: "var(--theme-surface)", color: "var(--theme-text)" }} />
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || why.trim().length < 3} onClick={() => void run(s.key, { skip: true, note: why })}>Skip</button>
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setSkipping(false)}>Cancel</button></div>
        : <button type="button" className={css.skip} onClick={() => setSkipping(true)}>Skip with a reason</button>) : null}
    </div>
  </details></li>;
}

export function Checklist({ c }: { c: CaseView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const first = c.person.name.split(" ")[0];
  async function run(key: string, body: Proposal) {
    setBusy(true);
    try {
      const out = await post<{ status: string; caseDone: boolean }>(`lifecycle/cases/${c.id}/steps/${key}`, body);
      notify({ id: `step:${key}`, tone: "success", title: `${STEP_LABEL[key]?.title ?? key}: ${out.status === "skipped" ? "skipped" : out.status === "done" ? "done" : "saved"}`, message: out.caseDone ? `${first}'s checklist is complete.` : undefined, timeout: 3000 });
      router.refresh();
    } catch (e) { notify({ id: `step:${key}`, tone: "error", title: "Not done", message: e instanceof Error ? e.message : "Not saved" }); } finally { setBusy(false); }
  }
  const can = c.canAct;
  const Btn = ({ k, body, children, primary = true, disabled }: { k: string; body: Proposal; children: ReactNode; primary?: boolean; disabled?: boolean }) =>
    can ? <button type="button" className={`${styles.btn} ${styles.btnSmall}${primary ? ` ${styles.btnPrimary}` : ""}`} style={{ justifySelf: "start" }} disabled={busy || disabled} onClick={() => void run(k, body)}>{children}</button> : null;
  const body = (s: Step): ReactNode => {
    const q = s.proposal;
    switch (s.key) {
      case "work": return <WorkStep s={s} people={c.people} can={can} busy={busy} run={run} first={first} />;
      case "projects": return <ProjectsStep s={s} people={c.people} can={can} busy={busy} run={run} />;
      case "pods": return <PodsStep s={s} people={c.people} can={can} busy={busy} run={run} />;
      // COMP-A: the days recorded here feed the full and final statement, worked out and approved in People & pay.
      case "settlement": return <><SettlementStep s={s} can={can} busy={busy} run={run} />
        <Link href={`/people/pay/${c.person.id}?do=settlement`} className={`${styles.btn} ${styles.btnSmall}`} style={{ justifySelf: "start" }}>Full and final in People &amp; pay</Link></>;
      case "assets": return <AssetsStep s={s} can={can} busy={busy} run={run} />;
      case "access": {
        const n = (num(q.sessions) ?? 0) + (num(q.appTokens) ?? 0);
        return <><div className={css.chips}><span>{q.credential ? "Can sign in" : "Sign-in ended"}</span><span>{plural(n, "live session")}</span><span>{plural(num(q.devices) ?? 0, "device")}</span></div>
          {s.status === "todo" ? <Btn k="access" body={{}}>End sign-in, sessions and devices</Btn> : null}
          <p className={css.note}>{first} can no longer sign in to Pulse or its apps. Their record and history stay.</p></>;
      }
      case "chats": {
        const groups = arr<Item>(q.groups);
        return <>{groups.length ? <div className={css.chips}>{groups.map((g) => <span key={g.id}>{g.name}</span>)}</div> : <p className={css.note}>Not in any group.</p>}
          {groups.length ? <Btn k="chats" body={{}}>Remove from {plural(groups.length, "group")}</Btn> : null}
          <p className={css.note}>Their past messages stay in each conversation, marked “former member”. Direct chats stay readable for the other person.</p></>;
      }
      case "workspace": return <WorkspaceStep s={s} c={c} busy={busy} run={run} />;
      case "alumni": return <AlumniStep s={s} c={c} busy={busy} run={run} />;
      case "record": return <><div className={css.chips}><span>Role: {String(q.role ?? "not set")}</span><span>Pod: {String(q.pod ?? "not set")}</span><span>Team: {String(q.department ?? "not set")}</span>
        <span>Joins {q.joinedOn ? dayYear(String(q.joinedOn)) : "date not set"}</span><span>Head: {String(q.manager ?? "not set")}</span></div>
        <Link href={`/people/${c.person.id}`} className={`${styles.btn} ${styles.btnSmall}`} style={{ justifySelf: "start" }}>Edit on their record</Link></>;
      case "invite": return <><p className={css.note}>{q.credential === "active" ? "They can sign in." : q.invitation ? `Invitation ${String(q.invitation)}.` : q.workspace ? "They sign in with their Workspace account." : "No invitation yet. Pulse sends nothing until you press Send on their record."}</p>
        {s.status === "todo" ? <Link href={`/hr?tab=onboard`} className={`${styles.btn} ${styles.btnSmall}`} style={{ justifySelf: "start" }}>Invite from Onboard team</Link> : null}</>;
      case "welcome": return <p className={css.note}>{q.completedAt ? `Finished on ${day(String(q.completedAt))}.` : q.seenAt ? "Started, not finished yet. They see it on /welcome and Pulse reminds them in the app." : "Not opened yet. It opens on their first sign-in."}</p>;
      case "groups": return <GroupsStep s={s} can={can} busy={busy} run={run} />;
      case "domains": return <DomainsStep s={s} can={can} busy={busy} run={run} first={first} labels={c.categories ?? {}} />;
      case "payroll": return <DateStep k="payroll" field="payrollFrom" label="Payroll counts from" value={String(q.payrollFrom ?? q.suggested ?? "")} s={s} can={can} busy={busy} run={run} />;
      case "probation": return <ProbationStep s={s} can={can} busy={busy} run={run} />;
      default: return null;
    }
  };
  return <ol className={css.steps}>{c.steps.map((s) => <StepCard key={s.key} c={c} s={s} run={run} busy={busy}>{body(s)}</StepCard>)}</ol>;
}

type StepProps = { s: Step; can: boolean; busy: boolean; run: (key: string, body: Proposal) => Promise<void> };

function WorkStep({ s, people, can, busy, run, first }: StepProps & { people: Brief[]; first: string }) {
  const tasks = arr<Item>(s.proposal.tasks), reviews = arr<Item>(s.proposal.reviews);
  const [to, setTo] = useState<Record<string, string>>(() => Object.fromEntries([...tasks, ...reviews].map((t) => [t.id, t.to?.id ?? ""])));
  const [note, setNote] = useState("");
  if (!tasks.length && !reviews.length) return <p className={css.note}>No open tasks, pool claims or reviews in {first}’s name.{num(s.proposal.imported) ? ` ${plural(num(s.proposal.imported)!, "imported tracker row")} without a status stay in their history.` : ""}</p>;
  const missing = tasks.some((t) => !to[t.id] && !t.claimed) || reviews.some((t) => !to[t.id]);
  return <>
    <ul className={css.items}>{tasks.map((t) => <li key={t.id}><span><b>{t.title}</b><small className={css.sub}>{[t.claimed ? "claimed from the pool" : t.status?.replace("_", " "), t.project, t.dueAt ? `due ${day(t.dueAt)}` : null].filter(Boolean).join(" · ")}</small></span>
      <PersonSelect value={to[t.id] ?? ""} onChange={(v) => setTo({ ...to, [t.id]: v })} people={people} label={`Who takes ${t.title}`} pool={t.claimed} /></li>)}
      {reviews.map((t) => <li key={t.id}><span><b>{t.title}</b><small className={css.sub}>{first} reviews this</small></span>
        <PersonSelect value={to[t.id] ?? ""} onChange={(v) => setTo({ ...to, [t.id]: v })} people={people} label={`Who reviews ${t.title}`} /></li>)}</ul>
    {can ? <><label className={css.field}><span>Handover note (added to each task)</span><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Where the files are, what is left, who the client contact is" /></label>
      <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} style={{ justifySelf: "start" }} disabled={busy || missing}
        onClick={() => void run("work", { note, tasks: tasks.map((t) => ({ id: t.id, to: to[t.id] || null })), reviews: reviews.map((t) => ({ id: t.id, to: to[t.id] })) })}>
        Hand over {plural(tasks.length + reviews.length, "item")}</button></> : null}
    <p className={css.note}>Each new owner is told in Pulse. Pulse proposed the best fit; change anyone before confirming.</p>
  </>;
}

function ProjectsStep({ s, people, can, busy, run }: StepProps & { people: Brief[] }) {
  const owned = arr<Item>(s.proposal.owned);
  const [to, setTo] = useState<Record<string, string>>(() => Object.fromEntries(owned.map((o) => [o.id, o.to?.id ?? ""])));
  const members = num(s.proposal.memberOf) ?? 0;
  return <>{owned.length ? <ul className={css.items}>{owned.map((o) => <li key={o.id}><span><b>{o.name}</b><small className={css.sub}>{o.kind === "internal" ? "Internal project" : "Client work"}</small></span>
    <PersonSelect value={to[o.id] ?? ""} onChange={(v) => setTo({ ...to, [o.id]: v })} people={people} label={`New owner of ${o.name}`} /></li>)}</ul> : <p className={css.note}>Owns no project.</p>}
    {members ? <p className={css.note}>Member of {plural(members, "project")}: the memberships end; the work they did stays credited.</p> : null}
    {can && (owned.length || members) ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} style={{ justifySelf: "start" }} disabled={busy || owned.some((o) => !to[o.id])}
      onClick={() => void run("projects", { projects: owned.map((o) => ({ id: o.id, to: to[o.id] })) })}>{owned.length ? `Transfer ${plural(owned.length, "project")}` : "End memberships"}</button> : null}</>;
}

function PodsStep({ s, people, can, busy, run }: StepProps & { people: Brief[] }) {
  const q = s.proposal; const reports = arr<Item>(q.reports), heads = arr<{ pod: string }>(q.heads), roles = arr<string>(q.roles), domains = arr<{ id: string; title: string }>(q.domains);
  const [to, setTo] = useState<Record<string, string>>(() => Object.fromEntries(reports.map((r) => [r.id, r.to?.id ?? ""])));
  const [head, setHead] = useState<Record<string, string>>({});
  const nothing = !q.pod && !q.manager && !reports.length && !heads.length && !roles.length && !domains.length;
  if (nothing) return <p className={css.note}>In no pod, holds no role and has no domain.</p>;
  return <>
    <div className={css.chips}>{q.pod ? <span>Pod: {String(q.pod)}</span> : null}{q.manager ? <span>Head: {String(q.manager)}</span> : null}{roles.map((r) => <span key={r}>Role: {r}</span>)}{domains.map((d) => <span key={d.id}>Domain: {d.title}</span>)}</div>
    {reports.length ? <ul className={css.items}>{reports.map((r) => <li key={r.id}><span><b>{r.name}</b><small className={css.sub}>reports to them</small></span>
      <PersonSelect value={to[r.id] ?? ""} onChange={(v) => setTo({ ...to, [r.id]: v })} people={people} label={`New head for ${r.name}`} /></li>)}</ul> : null}
    {heads.length ? <ul className={css.items}>{heads.map((h) => <li key={h.pod}><span><b>{h.pod}</b><small className={css.sub}>they head this pod</small></span>
      <PersonSelect value={head[h.pod] ?? ""} onChange={(v) => setHead({ ...head, [h.pod]: v })} people={people} label={`New head of ${h.pod}`} /></li>)}</ul> : null}
    {can ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} style={{ justifySelf: "start" }} disabled={busy || heads.some((h) => !head[h.pod])}
      onClick={() => void run("pods", { reports: reports.map((r) => ({ id: r.id, to: to[r.id] || null })), heads: heads.map((h) => ({ pod: h.pod, to: head[h.pod] })) })}>Move out of pods and roles</button> : null}
  </>;
}

function SettlementStep({ s, can, busy, run }: StepProps) {
  const q = s.proposal; const r = s.result;
  const pick = (k: string) => r[k] ?? q[k];
  const [f, setF] = useState({ lastWorkingDay: String(pick("lastWorkingDay") ?? ""), leaveDays: String(pick("leaveDays") ?? ""), noticeRecoveryDays: String(pick("noticeRecoveryDays") ?? ""),
    compOffDays: String(pick("compOffDays") ?? ""), settlementBy: String(pick("settlementBy") ?? "") });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const n = (v: string) => v === "" ? null : Number(v);
  return <>
    <div className={css.form}>
      <label className={css.field}><span>Last working day</span><input type="date" value={f.lastWorkingDay} onChange={set("lastWorkingDay")} disabled={!can} /></label>
      <label className={css.field}><span>Leave to encash (days)</span><input type="number" step="0.5" min="0" value={f.leaveDays} onChange={set("leaveDays")} disabled={!can} /></label>
      <label className={css.field}><span>Notice to recover (days)</span><input type="number" min="0" value={f.noticeRecoveryDays} onChange={set("noticeRecoveryDays")} disabled={!can} /></label>
      <label className={css.field}><span>Comp-off (days)</span><input type="number" step="0.5" min="0" value={f.compOffDays} onChange={set("compOffDays")} disabled={!can} /></label>
      <label className={css.field}><span>Settle by</span><input type="date" value={f.settlementBy} onChange={set("settlementBy")} disabled={!can} /></label>
    </div>
    <p className={css.note}>Pulse read: {num(q.leaveDays) !== null ? `${q.leaveDays} days of ${String(q.leaveKind ?? "paid")} leave available on the last day` : "no leave balance"}; notice {String(q.noticeServedDays ?? 0)} of {String(q.noticeRequiredDays ?? 0)} days served
      {q.ruleConfirmed ? "" : " (the exit rule is not confirmed yet: 30 days, settle within 45, until HR confirms one)"}. The amounts are worked out in the full and final (People &amp; pay); only days are recorded here.</p>
    {can ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} style={{ justifySelf: "start" }} disabled={busy || !f.lastWorkingDay}
      onClick={() => void run("settlement", { lastWorkingDay: f.lastWorkingDay, leaveDays: n(f.leaveDays), noticeRecoveryDays: n(f.noticeRecoveryDays), compOffDays: n(f.compOffDays), settlementBy: f.settlementBy || null })}>
      {s.status === "done" ? "Save changes" : "Confirm settlement inputs"}</button> : null}
  </>;
}

function AssetsStep({ s, can, busy, run }: StepProps) {
  const [items, setItems] = useState(arr<{ name: string; returned: boolean }>(s.proposal.items));
  const [extra, setExtra] = useState("");
  return <>
    <ul className={css.ticks}>{items.map((it, i) => <li key={`${it.name}${i}`}><label><input type="checkbox" checked={it.returned} disabled={!can}
      onChange={() => setItems(items.map((x, j) => j === i ? { ...x, returned: !x.returned } : x))} /><span>{it.name}</span></label></li>)}</ul>
    {can ? <div className={css.bar}><input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Add an item: SIM card, hard drive…" aria-label="Add an item" maxLength={80}
      style={{ flex: "1 1 220px", minHeight: 32, padding: "0 8px", border: "1px solid var(--theme-border)", borderRadius: 8, background: "var(--theme-surface)", color: "var(--theme-text)" }} />
      <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={extra.trim().length < 2} onClick={() => { setItems([...items, { name: extra.trim(), returned: false }]); setExtra(""); }}>Add</button>
      <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy} onClick={() => void run("assets", { items })}>Save · {items.filter((i) => i.returned).length} of {items.length} back</button></div> : null}
  </>;
}

function WorkspaceStep({ s, c, busy, run }: { s: Step; c: CaseView; busy: boolean; run: (key: string, body: Proposal) => Promise<void> }) {
  const q = s.proposal; const accounts = arr<string>(q.accounts), groups = arr<string>(q.groups); const ticks = (q.ticks ?? {}) as Record<string, { by: string; at: string }>;
  if (!accounts.length) return <p className={css.note}>No Workspace account of their own: nothing to do in Google Admin.</p>;
  const items = [
    { k: "suspend", t: `Suspend ${accounts.join(", ")}`, d: "Google Admin → Users → Suspend. Keeps the mail and files." },
    { k: "drive", t: "Transfer their Drive files", d: "Google Admin → Apps → Drive → Transfer ownership, to whoever took over the work." },
    { k: "groups", t: "Remove from Google groups", d: groups.length ? groups.join(", ") : "Not in any group Pulse sees." },
    { k: "forward", t: "Set an e-mail forward", d: "Forward their address to their head, or set an auto-reply." },
  ];
  return <>
    <ul className={css.ticks}>{items.map((it) => <li key={it.k}><label><input type="checkbox" checked={!!ticks[it.k]} disabled={!c.canWorkspace || busy}
      onChange={(e) => void run("workspace", { item: it.k, done: e.target.checked })} /><span>{it.t}<small>{ticks[it.k] ? `Ticked by ${ticks[it.k].by}, ${day(ticks[it.k].at)}` : it.d}</small></span></label></li>)}</ul>
    <p className={css.note}>{c.canWorkspace ? "Tick each one after doing it in Google Admin." : "An admin ticks these after doing them in Google Admin."} Pulse never changes Workspace itself.</p>
  </>;
}

function AlumniStep({ s, c, busy, run }: { s: Step; c: CaseView; busy: boolean; run: (key: string, body: Proposal) => Promise<void> }) {
  const [type, setType] = useState<string>(c.leftType ?? "");
  const [on, setOn] = useState(c.effectiveOn);
  if (s.status === "done") return <p className={css.note}>Alumni since {day(String(s.proposal.on ?? s.result.on ?? c.effectiveOn))}{s.proposal.leftType || s.result.leftType ? ` · ${LEFT_LABEL[String(s.proposal.leftType ?? s.result.leftType) as LeftType].toLowerCase()}` : ""}.</p>;
  return <>{c.canAct ? <div className={css.bar}>
    <input type="date" value={on} onChange={(e) => setOn(e.target.value)} aria-label="Last working day" />
    <select value={type} onChange={(e) => setType(e.target.value)} aria-label="How they left">
      <option value="">How they left…</option>{(["resigned", "terminated", "contract_ended"] as const).map((t) => <option key={t} value={t}>{LEFT_LABEL[t]}</option>)}</select>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy || !type} onClick={() => void run("alumni", { effectiveOn: on, leftType: type })}>Mark as left on {day(on)}</button>
  </div> : null}<p className={css.note}>Available from the last working day. Before it, they are on notice.</p></>;
}

function GroupsStep({ s, can, busy, run }: StepProps) {
  const q = s.proposal; const sug = (q.suggested ?? null) as { pod: string | null; department: string | null } | null;
  const groups = arr<string>(q.groups);
  return <>{groups.length ? <div className={css.chips}>{groups.map((g) => <span key={g}>{g}</span>)}</div> : <p className={css.note}>In no group yet: their pod and team decide it.</p>}
    {s.status === "todo" && sug && can ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} style={{ justifySelf: "start" }} disabled={busy}
      onClick={() => void run("groups", { pod: sug.pod, department: sug.department })}>Use {[sug.pod, sug.department].filter(Boolean).join(" and ")}, like others in the role</button> : null}</>;
}

function DomainsStep({ s, can, busy, run, first, labels }: StepProps & { first: string; labels: Record<string, string> }) {
  const current = arr<{ title: string; status: string }>(s.proposal.current), sug = arr<string>(s.proposal.suggested);
  if (current.length) return <div className={css.chips}>{current.map((d) => <span key={d.title}>{d.title} · {d.status}</span>)}</div>;
  const name = (k: string) => labels[k] ?? k.replace(/_/g, " ");
  return <>{sug.length ? <p className={css.note}>Others in the same role have domains in: {sug.map(name).join(", ")}.</p> : <p className={css.note}>No one in the same role has a domain yet.</p>}
    {can && sug.length ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} style={{ justifySelf: "start" }} disabled={busy}
      onClick={() => void run("domains", { categories: sug.slice(0, 3), title: `${first}'s work` })}>Propose these to {first}</button> : null}
    <p className={css.note}>A proposal waits for {first} to agree; nothing becomes theirs without it.</p></>;
}

function DateStep({ k, field, label, value, s, can, busy, run }: StepProps & { k: string; field: string; label: string; value: string }) {
  const [v, setV] = useState(value);
  return <div className={css.bar}><label className={css.field}><span>{label}</span><input type="date" value={v} onChange={(e) => setV(e.target.value)} disabled={!can} /></label>
    {can ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} style={{ alignSelf: "end" }} disabled={busy || !v} onClick={() => void run(k, { [field]: v })}>{s.status === "done" ? "Save" : "Confirm"}</button> : null}</div>;
}

function ProbationStep({ s, can, busy, run }: StepProps) {
  const q = s.proposal;
  const [from, setFrom] = useState(String(q.from ?? q.suggestedFrom ?? "")), [to, setTo] = useState(String(q.to ?? q.suggestedTo ?? ""));
  return <div className={css.bar}>
    <label className={css.field}><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} disabled={!can} /></label>
    <label className={css.field}><span>Ends</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} disabled={!can} /></label>
    {can ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} style={{ alignSelf: "end" }} disabled={busy || !from || !to} onClick={() => void run("probation", { from, to })}>{s.status === "done" ? "Save" : "Confirm"}</button> : null}
  </div>;
}
