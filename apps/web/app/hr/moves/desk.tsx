"use client";
// HR → People moves (LIFECYCLE): where everyone is between candidate and alumni, HR's review of people who have probably
// left (Pulse proposes from evidence, HR confirms with one click), the joining and leaving checklists in progress, and
// the latest moves. Nothing here sends a message or an invitation, or changes Google Workspace.
import { CalendarClock, Check, FileSpreadsheet, Mail, MonitorX, RefreshCw, ScrollText, UserPlus, UserRoundX, Waves } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { day, dayYear, plural } from "../../lib/format";
import { Modal, post } from "../../records";
import { Avatar, Badge, styles } from "../../ui";
import { MoveButton } from "./move";
import { LEFT_LABEL, STAGE_LABEL, STEP_LABEL, type LeftType, type Moves, type Reason, type Review } from "./types";
import css from "./moves.module.css";
import { DateField } from "../../kit/date-field";
import { SelectField } from "../../kit/select-field";

const msg = (e: unknown) => e instanceof Error ? e.message : "Not saved";
const SOURCE_ICON = { mail: Mail, workspace: MonitorX, hr_sheet: FileSpreadsheet, attendance: CalendarClock, work: Waves, roster: ScrollText } as const;
const CONFIDENCE = { high: { label: "Strong evidence", tone: "warning" }, medium: { label: "Some evidence", tone: "neutral" }, low: { label: "Weak evidence", tone: "neutral" } } as const;
const TYPES: Exclude<LeftType, "not_joined">[] = ["resigned", "terminated", "contract_ended"];

function Reasons({ reasons }: { reasons: Reason[] }) {
  const line = (r: Reason, i: number) => { const Icon = SOURCE_ICON[r.source] ?? Waves;
    return <li key={i} data-strong={r.weight >= 3 ? "" : undefined} data-void={r.weight === 0 && r.kind !== "cancelled" ? "" : undefined}><Icon size={13} aria-hidden="true" /><span>{r.summary}</span></li>; };
  const first = reasons.slice(0, 2), rest = reasons.slice(2);
  return <ul className={css.reasons}>{first.map(line)}
    {rest.length ? <li><details className={css.more}><summary>{plural(rest.length, "more reason")}</summary><ul className={css.reasons}>{rest.map((r, i) => line(r, i + 2))}</ul></details></li> : null}
  </ul>;
}

/** One person HR should look at: why Pulse thinks they left, and "Mark as left on <date>, <type>" in one click. */
function ReviewCard({ r, today, canAct }: { r: Review; today: string; canAct: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(r.proposedOn ?? today), [type, setType] = useState<string>(r.proposedType ?? "");
  const [editing, setEditing] = useState(false), [dismissing, setDismissing] = useState(false), [note, setNote] = useState("");
  const [busy, setBusy] = useState(false), [done, setDone] = useState<{ text: string; caseId?: string } | null>(null);
  async function decide(action: "confirm" | "dismiss") {
    if (action === "confirm" && !type && on <= today) { setEditing(true); return; }
    setBusy(true);
    try {
      const out = await post<{ caseId?: string; stage?: string }>(`lifecycle/reviews/${r.personId}`, action === "confirm" ? { action, effectiveOn: on, leftType: type } : { action, note });
      setDone(action === "confirm" ? { text: out.stage === "notice" ? `On notice until ${day(on)}` : `Alumni from ${day(on)}`, caseId: out.caseId } : { text: "Kept as current" });
      router.refresh();
    } catch (e) { notify({ id: `review:${r.personId}`, tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  const conf = CONFIDENCE[r.confidence];
  return <li className={css.card} data-done={done ? "" : undefined} data-review={r.personId}>
    <Avatar name={r.name} id={r.personId} photoAt={r.photoAt} size={34} />
    <div className={css.top}>
      <span className={css.who}><b>{r.name}</b><small>{[r.role, r.pod].filter(Boolean).join(" · ") || "Team"}{r.alreadyInactive ? " · already not current" : ""}</small></span>
      <Badge tone={conf.tone}>{conf.label}</Badge>
    </div>
    <Reasons reasons={r.reasons} />
    {!canAct ? null : done ? <div className={css.actions}><span className={css.done}><Check size={13} aria-hidden="true" />{done.text}</span>
      {done.caseId ? <Link className={`${styles.btn} ${styles.btnSmall}`} href={`/hr/moves/${done.caseId}`}>Open the leaving checklist</Link> : null}</div>
    : dismissing ? <div className={css.actions}>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why: still working, resignation withdrawn…" aria-label="Why they have not left" maxLength={500} autoFocus style={{ flex: "1 1 220px" }} />
      <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || note.trim().length < 3} onClick={() => void decide("dismiss")}>Keep as current</button>
      <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setDismissing(false)}>Cancel</button>
    </div> : <div className={css.actions}>
      {editing ? <>
        <DateField value={on} onChange={(e) => setOn(e.target.value)} aria-label="Last working day" />
        <SelectField value={type} onChange={(e) => setType(e.target.value)} aria-label="How they left"><option value="">How they left…</option>{TYPES.map((t) => <option key={t} value={t}>{LEFT_LABEL[t]}</option>)}</SelectField>
      </> : null}
      <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy} onClick={() => void decide("confirm")}>
        <UserRoundX size={13} aria-hidden="true" />{on > today ? `On notice until ${day(on)}` : `${r.alreadyInactive ? "Record" : "Mark"} as left on ${day(on)}`}{type ? `, ${LEFT_LABEL[type as LeftType].toLowerCase()}` : ""}</button>
      {!editing ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setEditing(true)}>Change</button> : null}
      {!r.alreadyInactive ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setDismissing(true)}>Still here</button> : null}
    </div>}
  </li>;
}

function AddCandidate({ pods }: { pods: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [f, setF] = useState({ name: "", role: "", pod: "", department: "", stage: "candidate", note: "" });
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { await post("lifecycle/candidates", f); setOpen(false); setF({ name: "", role: "", pod: "", department: "", stage: "candidate", note: "" }); router.refresh();
      notify({ id: "candidate", tone: "success", title: `${f.name} added as ${f.stage === "offer" ? "an offer" : "a candidate"}`, message: "Not current until they join: no groups, pickers or invitations yet.", timeout: 3500 }); }
    catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setOpen(true)}><UserPlus size={13} aria-hidden="true" />Add a candidate</button>
    {open ? <Modal title="Add a candidate" sub="A staff record that is not current until they join" onClose={() => setOpen(false)}
      foot={<><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button type="submit" form="add-candidate" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || f.name.trim().length < 2 || f.role.trim().length < 2}>Add</button></>}>
      <form id="add-candidate" className={css.form} onSubmit={save}>
        <label className={css.field} data-wide=""><span>Full name</span><input value={f.name} onChange={set("name")} required maxLength={80} autoFocus /></label>
        <label className={css.field}><span>Role</span><input value={f.role} onChange={set("role")} required maxLength={80} placeholder="e.g. Video editor" /></label>
        <label className={css.field}><span>Stage</span><SelectField value={f.stage} onChange={set("stage")}><option value="candidate">Candidate</option><option value="offer">Offer made</option></SelectField></label>
        <label className={css.field}><span>Pod</span><SelectField value={f.pod} onChange={set("pod")}><option value="">Not yet</option>{pods.map((p) => <option key={p}>{p}</option>)}</SelectField></label>
        <label className={css.field}><span>Team</span><input value={f.department} onChange={set("department")} maxLength={60} placeholder="e.g. Creative" /></label>
        <label className={css.field} data-wide=""><span>Note</span><textarea value={f.note} onChange={set("note")} maxLength={500} placeholder="Where they came from, the interview, the offer" /></label>
        {error ? <p className={styles.muted} role="alert" style={{ color: "var(--theme-danger)" }}>{error}</p> : null}
      </form>
    </Modal> : null}
  </>;
}

function Refresh() {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} title="Read Pulse's own evidence again: salary sheets, quiet weeks, check-ins"
    onClick={async () => { setBusy(true); try { await post("lifecycle/refresh"); router.refresh(); } catch (e) { notify({ id: "lc-refresh", tone: "error", title: "Not refreshed", message: msg(e) }); } finally { setBusy(false); } }}>
    <RefreshCw size={13} aria-hidden="true" />Check again</button>;
}

export function PeopleMoves({ data }: { data: Moves }) {
  const review = data.review ?? [];
  const current = review.filter((r) => !r.alreadyInactive), record = review.filter((r) => r.alreadyInactive);
  const leaving = data.cases.filter((c) => c.kind === "leaving"), joining = data.cases.filter((c) => c.kind === "joining");
  const tiles = [
    { label: "Possibly left", value: current.length, tone: current.length ? "warning" : undefined },
    { label: "On notice", value: data.counts.notice },
    { label: "Joining & probation", value: data.counts.joining + data.counts.probation },
    { label: "Candidates & offers", value: data.counts.candidate + data.counts.offer },
    { label: "Active", value: data.counts.active },
    { label: "Alumni", value: data.counts.left },
  ];
  const caseRow = (c: Moves["cases"][number]) => <Link key={c.id} href={`/hr/moves/${c.id}`} className={css.row} data-case={c.id}>
    <Avatar name={c.person.name} id={c.person.id} photoAt={c.person.photoAt} size={30} />
    <span className={css.who}><b>{c.kind === "leaving" ? "Leaving" : "Joining"}: {c.person.name}</b>
      <small>{c.kind === "leaving" ? `Last working day ${dayYear(c.effectiveOn)}${c.leftType ? ` · ${LEFT_LABEL[c.leftType].toLowerCase()}` : ""}` : `Joins ${dayYear(c.effectiveOn)}`}{c.next ? ` · next: ${STEP_LABEL[c.next]?.title.toLowerCase() ?? c.next}` : ""}</small></span>
    <span className={css.end}><span className={css.progress} aria-hidden="true"><i style={{ width: `${Math.round((c.done / Math.max(1, c.total)) * 100)}%` }} /></span>{c.done} of {c.total} done</span>
  </Link>;
  return <div className={css.desk} data-grow="">
    <ol className={css.stages} aria-label="Where everyone is">{tiles.map((t) => <li key={t.label} data-tone={t.tone}><b>{t.value}</b><span>{t.label}</span></li>)}</ol>
    <div className={css.grid}>
      <div className={css.col}>
        <section className={css.section} aria-label="Possibly left: confirm">
          <div className={css.head}><h3>Possibly left: confirm<small>{current.length ? plural(current.length, "person", "people") : "nobody"}</small></h3>
            <div className={css.tools}>{data.can.review ? <Refresh /> : null}</div>
            <p>Pulse proposes from exit mails, Workspace, salary sheets and quiet weeks. Nothing changes until you confirm; until then they stay out of new-group defaults.</p></div>
          <div className={css.scroll}>{data.review === null ? <p className={css.empty}>The review list is for HR and admins.</p>
            : current.length ? <ul className={css.list}>{current.map((r) => <ReviewCard key={r.personId} r={r} today={data.today} canAct={data.can.act} />)}</ul>
            : <p className={css.empty}>Nobody looks like they have left. {data.lastScan ? `Evidence last read ${day(data.lastScan)}.` : ""}</p>}
            {record.length ? <details className={css.more} style={{ marginTop: 10 }}><summary>Already not current: record how and when {plural(record.length, "person", "people")} left</summary>
              <ul className={css.list} style={{ marginTop: 8 }}>{record.map((r) => <ReviewCard key={r.personId} r={r} today={data.today} canAct={data.can.act} />)}</ul></details> : null}
            {data.unmatched.length ? <details className={css.more} style={{ marginTop: 10 }}><summary>{plural(data.unmatched.length, "exit mail")} for people who are not in Pulse</summary>
              <ul className={css.reasons} style={{ marginTop: 6 }}>{data.unmatched.map((u, i) => <li key={i}><Mail size={13} aria-hidden="true" /><span><b>{u.name}</b> · {u.summary}</span></li>)}</ul></details> : null}
          </div>
        </section>
      </div>
      <div className={css.col}>
        <section className={css.section} aria-label="Joining and leaving in progress">
          <div className={css.head}><h3>In progress<small>{plural(data.cases.length, "checklist")}</small></h3>
            <div className={css.tools}>{data.can.act ? <AddCandidate pods={data.pods} /> : null}</div></div>
          <div className={css.scroll}>{data.cases.length ? <>{leaving.map(caseRow)}{joining.map(caseRow)}</>
            : <p className={css.empty}>No joining or leaving checklist is open. Moving someone to Joining or Notice opens one.</p>}
            {data.pipeline.filter((p) => !data.cases.some((c) => c.person.id === p.id)).map((p) => <div key={p.id} className={css.row}>
              <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={30} />
              <span className={css.who}><Link href={`/people/${p.id}`}><b>{p.name}</b></Link><small>{STAGE_LABEL[p.stage]}{p.since ? ` since ${day(p.since)}` : ""} · {[p.role, p.pod].filter(Boolean).join(" · ")}</small></span>
              {data.can.act ? <MoveButton person={{ id: p.id, name: p.name }} stage={p.stage} today={data.today} small /> : null}
            </div>)}
          </div>
        </section>
        <section className={css.section} aria-label="Recent moves">
          <div className={css.head}><h3>Recent moves<small>dated and attributed</small></h3><Link href="/people?status=past" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`}>{plural(data.counts.left, "alumnus", "alumni")}</Link></div>
          <div className={css.scroll}>{data.moves.length ? <ul className={css.moves}>{data.moves.slice(0, 14).map((m) => <li key={m.id}><time dateTime={m.on}>{day(m.on)}</time>
            <span><Link href={`/people/${m.personId}`}>{m.name}</Link> {m.kind === "stage" ? <>{m.from ? `${STAGE_LABEL[m.from]} → ` : ""}<b>{m.to ? STAGE_LABEL[m.to] : ""}</b>{m.leftType ? ` (${LEFT_LABEL[m.leftType].toLowerCase()})` : ""}</>
              : m.kind === "change" ? <>{Object.entries(m.detail as Record<string, { from: string | null; to: string | null }>).map(([k, v]) => `${k} ${v.from ?? "–"} → ${v.to ?? "–"}`).join(", ")}</>
              : <>review {String((m.detail as { decision?: string }).decision ?? "")}</>}
              <small className={css.sub}> · {m.by ?? "Pulse"}</small></span></li>)}</ul>
            : <p className={css.empty}>Moves appear here as HR records them.</p>}</div>
        </section>
      </div>
    </div>
  </div>;
}
