"use client";
// PEOPLE-CONTACTS (owner, 11 Oct 2026): "My info": what the person keeps up to date themselves, on one calm page that
// works on a phone. Each card says what it holds, shows it, and has one way to change it. HR sees the same page for
// anyone (with bank details only for the HR role, decided in the database), checks bank changes and decides requests.
// A new legal name, or a different date of birth once one is on file, is a request HR approves; everything else saves
// at once and lands in the record's history.
import { BadgeCheck, CalendarHeart, Copy, Eye, EyeOff, FileCheck2, HeartPulse, Inbox, Landmark, Languages, Lock, PhoneCall, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { dayYear } from "../../lib/format";
import { Modal, RecordForm, post } from "../../records";
import { Badge, styles } from "../../ui";
import { BankForm, type BankInput } from "../bank-form";
import css from "./my-info.module.css";

type Details = Partial<Record<"dob" | "address" | "city" | "pincode" | "bloodGroup" | "emergencyName" | "emergencyRelation" | "emergencyPhone" | "fatherName" | "personalEmail" | "personalPhone", string | null>>;
type Doc = { kind: string; label: string; required: boolean; idNumber: string | null; document: { id: string; status: string; masked?: string | null; hasFile: boolean; addedAt: string; note?: string | null } | null };
type BankDetails = { masked: string | null; summary: { holder: string; bank: string; branch: string | null; ifsc: string; last4: string; upi: string | null } | null;
  status: "missing" | "pending" | "confirmed"; source: "self" | "hr" | null; updatedAt: string | null; updatedBy: string | null; checkedAt: string | null; checkedBy: string | null;
  canEdit: boolean; canCheck: boolean; canReveal: boolean };
type Change = { id: string; field: "name" | "dob"; from: string | null; to: string; note: string | null; status: string; requestedAt: string; decidedAt: string | null; decisionNote: string | null; decidedBy: string | null };
export type MyInfoData = {
  person: { id: string; name: string; firstName: string; role: string | null; pod: string | null; workPhone: string | null };
  self: boolean; canSeeDetails: boolean; canSeeIds: boolean; details: Details | null; documents: Doc[]; missing: string[]; percent: number;
  profile: { about: string | null; pronouns: string | null; languages: string[]; workPhone: string | null; workEmail: string | null; skills: string[] };
  bankDetails: BankDetails | null; changes: Change[]; filesReady: boolean;
  can: { edit: boolean; bank: boolean; decide: boolean; request: boolean };
};

const MISSING: Record<string, { label: string; to: string }> = {
  dob: { label: "Date of birth", to: "personal" }, phone: { label: "Phone", to: "contact" }, email: { label: "Personal e-mail", to: "contact" },
  address: { label: "Address", to: "personal" }, emergency: { label: "Emergency contact", to: "emergency" }, bank: { label: "Bank details", to: "bank" }, photo: { label: "Photo", to: "top" },
};
const DOC_STATUS: Record<string, { label: string; tone: "success" | "warning" | "neutral" }> = { on_file: { label: "On file", tone: "neutral" }, verified: { label: "Checked by HR", tone: "success" }, rejected: { label: "New one needed", tone: "warning" } };
const message = (e: unknown) => e instanceof Error ? e.message : "Not saved";
const SAVED = (me: boolean) => me ? "Saved. It’s on your profile now." : "Saved";

function Card({ id, icon, title, sub, tools, children, tone }: { id: string; icon: ReactNode; title: string; sub?: ReactNode; tools?: ReactNode; children: ReactNode; tone?: "attention" }) {
  return <section id={`info-${id}`} className={css.card} data-tone={tone} aria-labelledby={`info-${id}-title`}>
    <header className={css.cardHead}><span className={css.cardIcon} aria-hidden="true">{icon}</span><div><h3 id={`info-${id}-title`}>{title}</h3>{sub ? <p>{sub}</p> : null}</div>{tools ? <span className={css.tools}>{tools}</span> : null}</header>
    <div className={css.cardBody}>{children}</div>
  </section>;
}
function Row({ label, value, empty = "Not added yet", mono }: { label: string; value?: ReactNode; empty?: string; mono?: boolean }) {
  const has = value !== null && value !== undefined && value !== "";
  return <div className={css.row}><dt>{label}</dt><dd className={mono ? css.mono : undefined} data-empty={has ? undefined : ""}>{has ? value : empty}</dd></div>;
}

export function MyInfo({ data }: { data: MyInfoData }) {
  const p = data.person, d = data.details ?? {}, me = data.self, first = p.firstName;
  const base = `onboarding/${p.id}`;
  const missing = data.missing.filter((k) => !k.startsWith("doc:")).map((k) => ({ key: k, ...(MISSING[k] ?? { label: k, to: "top" }) }));
  const docsMissing = data.missing.filter((k) => k.startsWith("doc:")).length;
  const go = (to: string) => document.getElementById(`info-${to}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const pending = data.changes.filter((c) => c.status === "pending");
  const dobPending = pending.find((c) => c.field === "dob"), namePending = pending.find((c) => c.field === "name");
  const fieldsSaved = SAVED(me);

  return <div className={css.page} data-grow="">
    {/* How complete it is, and a tap to what is missing. */}
    <section className={css.progress} aria-label="Profile completeness">
      <span className={css.ring} style={{ "--p": data.percent } as React.CSSProperties} aria-hidden="true"><b>{data.percent}%</b></span>
      <div>
        <h3>{data.percent >= 100 ? (me ? "Your profile is complete" : `${first}’s profile is complete`) : me ? "Your profile" : `${first}’s profile`}</h3>
        <p>{data.percent >= 100 ? "Thank you. Keep it up to date here whenever something changes." : missing.length || docsMissing ? "Still to add:" : ""}</p>
        {missing.length || docsMissing ? <div className={css.todo}>{missing.map((m) => <button key={m.key} type="button" onClick={() => go(m.to)}>{m.label}</button>)}
          {docsMissing ? <button type="button" onClick={() => go("documents")}>{docsMissing === 1 ? "A document" : `${docsMissing} documents`}</button> : null}</div> : null}
      </div>
      {pending.length ? <span className={css.pendingNote}><Inbox size={14} aria-hidden="true" />{pending.length === 1 ? "1 request waiting for HR" : `${pending.length} requests waiting for HR`}</span> : null}
    </section>

    <div className={css.grid}>
      <Card id="about" icon={<Sparkles size={16} />} title={me ? "About you" : "About"} sub={me ? "What colleagues see on your profile." : `What colleagues see on ${first}’s profile.`}
        tools={data.can.edit ? <RecordForm path={`people/${p.id}/info`} title={me ? "About you" : `About ${first}`} label="Edit" variant="ghost" done={fieldsSaved}
          fields={[{ key: "about", label: "A line about you", type: "textarea", maxLength: 400, placeholder: "What you do, what you love working on, how to reach you best…", wide: true },
            { key: "pronouns", label: "Pronouns", placeholder: "e.g. she/her, he/him, they/them", suggest: ["she/her", "he/him", "they/them"] },
            { key: "languages", label: "Languages", placeholder: "Marathi, Hindi, English", hint: "Separate them with commas." }]}
          values={{ about: data.profile.about, pronouns: data.profile.pronouns, languages: data.profile.languages.join(", ") }} /> : undefined}>
        {data.profile.about ? <p className={css.about}>{data.profile.about}</p> : <p className={css.muted}>{me ? "Add a line about yourself: what you do and what you’re good at." : "Nothing written yet."}</p>}
        <dl className={css.rows}>
          <Row label="Pronouns" value={data.profile.pronouns} empty="Not shared" />
          <Row label="Languages" value={data.profile.languages.length ? <span className={css.tags}>{data.profile.languages.map((l) => <span key={l}><Languages size={11} aria-hidden="true" />{l}</span>)}</span> : null} empty="Not added" />
        </dl>
      </Card>

      <Card id="contact" icon={<PhoneCall size={16} />} title="Contact" sub="Work details are shown to colleagues; personal ones only to you and HR."
        tools={data.can.edit && data.details ? <RecordForm path={`${base}/details`} title="Personal contact" label="Edit" variant="ghost" done={fieldsSaved}
          fields={[{ key: "personalPhone", label: "Personal phone", type: "tel", placeholder: "+91 …" }, { key: "personalEmail", label: "Personal e-mail", type: "email" }]}
          values={{ personalPhone: d.personalPhone, personalEmail: d.personalEmail }} note="Kept in the restricted HR record: only you and HR see it." /> : undefined}>
        <dl className={css.rows}>
          <Row label="Work e-mail" value={data.profile.workEmail} empty="No company e-mail" />
          <Row label="Work phone" value={data.profile.workPhone ? <span className={css.inline}>{data.profile.workPhone}<WorkPhone id={p.id} value={data.profile.workPhone} can={data.can.edit} me={me} /></span> : data.can.edit ? <WorkPhone id={p.id} value={null} can me={me} /> : null} empty="Not added" />
          {data.details ? <><Row label="Personal phone" value={d.personalPhone} /><Row label="Personal e-mail" value={d.personalEmail} /></> : <Row label="Personal" value={<span className={css.locked}><Lock size={12} aria-hidden="true" />Only {first} and HR see this</span>} />}
        </dl>
      </Card>

      {data.details ? <Card id="personal" icon={<UserRound size={16} />} title="Personal details" sub="For HR records and payroll. Only you and HR see them."
        tools={data.can.edit ? <RecordForm path={`${base}/details`} title="Personal details" label="Edit" variant="ghost" done={fieldsSaved}
          fields={[...(d.dob && me ? [] : [{ key: "dob", label: "Date of birth", type: "date" as const }]), { key: "bloodGroup", label: "Blood group", placeholder: "O+", suggest: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] },
            { key: "fatherName", label: "Father’s name" }, { key: "address", label: "Address", type: "textarea", wide: true }, { key: "city", label: "City" }, { key: "pincode", label: "PIN code", placeholder: "411001" }]}
          values={{ dob: d.dob, bloodGroup: d.bloodGroup, fatherName: d.fatherName, address: d.address, city: d.city, pincode: d.pincode }}
          note={d.dob && me ? "Your date of birth is on file; ask HR to change it below." : undefined} /> : undefined}>
        <dl className={css.rows}>
          <Row label="Date of birth" value={d.dob ? <span className={css.inline}><CalendarHeart size={13} aria-hidden="true" />{dayYear(d.dob)}{dobPending ? <Badge tone="warning">Change asked</Badge> : null}</span> : null} />
          <Row label="Blood group" value={d.bloodGroup} />
          <Row label="Father’s name" value={d.fatherName} />
          <Row label="Address" value={[d.address, d.city, d.pincode].filter(Boolean).join(", ") || null} />
        </dl>
        {me && d.dob && !dobPending ? <ChangeRequest field="dob" label="Ask HR to correct my date of birth" current={d.dob} /> : null}
      </Card> : null}

      {data.details ? <Card id="emergency" icon={<HeartPulse size={16} />} title="Emergency contact" sub="Who HR calls if something happens to you at work."
        tools={data.can.edit ? <RecordForm path={`${base}/details`} title="Emergency contact" label={d.emergencyName ? "Edit" : "Add"} variant="ghost" done={fieldsSaved}
          fields={[{ key: "emergencyName", label: "Name", required: true }, { key: "emergencyRelation", label: "Relation", placeholder: "Mother, spouse, friend…", suggest: ["Mother", "Father", "Spouse", "Brother", "Sister", "Friend"] }, { key: "emergencyPhone", label: "Phone", type: "tel", required: true }]}
          values={{ emergencyName: d.emergencyName, emergencyRelation: d.emergencyRelation, emergencyPhone: d.emergencyPhone }} /> : undefined}
        tone={!d.emergencyName ? "attention" : undefined}>
        {d.emergencyName ? <dl className={css.rows}><Row label="Name" value={d.emergencyName} /><Row label="Relation" value={d.emergencyRelation} /><Row label="Phone" value={d.emergencyPhone} /></dl>
          : <p className={css.muted}>{me ? "Add someone HR can call in an emergency." : "No emergency contact yet."}</p>}
      </Card> : null}

      {data.bankDetails ? <BankCard data={data} /> : data.can.bank === false && !me ? <Card id="bank" icon={<Landmark size={16} />} title="Bank for salary"><p className={css.locked}><Lock size={12} aria-hidden="true" />Bank details are visible to {first} and HR only.</p></Card> : null}

      <Card id="documents" icon={<FileCheck2 size={16} />} title="Documents" sub={data.canSeeIds ? "Identity documents HR asked for. Files are encrypted; every opening is logged." : "What is on file (not the documents themselves)."}
        tools={me ? <Link className={`${styles.btn} ${styles.btnGhost}`} href="/welcome?step=documents">Add or replace</Link> : null}>
        {data.documents.length ? <ul className={css.docs}>{data.documents.map((doc) => {
          const s = doc.document ? DOC_STATUS[doc.document.status] ?? { label: doc.document.status, tone: "neutral" as const } : null;
          return <li key={doc.kind}><span className={css.docName}><b>{doc.label}</b><small>{doc.document?.masked ?? (doc.document?.hasFile ? "File on file" : doc.required ? "Needed" : "Optional")}</small></span>
            {s ? <Badge tone={s.tone}>{s.label}</Badge> : <Badge tone={doc.required ? "warning" : "neutral"}>{doc.required ? "Missing" : "Not added"}</Badge>}</li>;
        })}</ul> : <p className={css.muted}>HR has not asked for any documents.</p>}
      </Card>

      {data.changes.length || data.can.request ? <Card id="requests" icon={<ShieldCheck size={16} />} title={me ? "Requests to HR" : "Requests"} sub={me ? "Your legal name and date of birth change only when HR approves." : `What ${first} asked HR to change.`}>
        {data.changes.length ? <ul className={css.changes}>{data.changes.map((c) => <ChangeItem key={c.id} c={c} me={me} canDecide={data.can.decide} />)}</ul> : <p className={css.muted}>No requests.</p>}
        {me && !namePending ? <ChangeRequest field="name" label="Ask HR to change my name" current={p.name} /> : null}
      </Card> : null}
    </div>
  </div>;
}

function WorkPhone({ id, value, can, me }: { id: string; value: string | null; can: boolean; me: boolean }) {
  if (!can) return null;
  return <RecordForm path={`people/${id}/self`} title="Work phone" label={value ? "Change" : "Add"} variant="link" icon="none" done={SAVED(me)}
    fields={[{ key: "phone", label: "Work phone", type: "tel", wide: true, placeholder: "The number colleagues can reach you on" }]} values={{ phone: value }} note="Leave it empty to remove the number." />;
}
function ChangeRequest({ field, label, current }: { field: "name" | "dob"; label: string; current: string }) {
  return <div className={css.request}><RecordForm path="me/changes" extra={{ field }} title={field === "name" ? "Change my name" : "Correct my date of birth"} label={label} variant="link" icon="none" action="Send to HR" done="Sent to HR"
    fields={[field === "name" ? { key: "value", label: "Your full name, as on your ID", required: true, wide: true } : { key: "value", label: "Date of birth", type: "date", required: true },
      { key: "note", label: "Anything HR should know", type: "textarea", placeholder: field === "name" ? "e.g. after marriage; the spelling on my PAN" : "e.g. the date on my Aadhaar" }]}
    values={{ value: field === "name" ? current : "" }} complete note="HR sees it in Pulse and approves or declines it. Until then your record stays as it is." /></div>;
}
function ChangeItem({ c, me, canDecide }: { c: Change; me: boolean; canDecide: boolean }) {
  const router = useRouter();
  const what = c.field === "name" ? "Name" : "Date of birth";
  const show = (v: string | null) => v ? (c.field === "dob" ? dayYear(v) : v) : "nothing";
  async function decide(approve: boolean) {
    try { await post(`profile-changes/${c.id}`, { approve }); notify({ id: "change", tone: "success", title: approve ? "Approved and changed" : "Declined", timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "change", tone: "error", title: "Not saved", message: message(e) }); }
  }
  async function withdraw() {
    try { await post(`profile-changes/${c.id}/withdraw`); router.refresh(); } catch (e) { notify({ id: "change", tone: "error", title: "Not withdrawn", message: message(e) }); }
  }
  return <li data-status={c.status}><span className={css.changeText}><b>{what}</b><small>{c.field === "dob" && !me ? `To ${show(c.to)}` : `${show(c.from)} → ${show(c.to)}`}{c.note ? ` · “${c.note}”` : ""}</small>
    {c.status !== "pending" ? <small>{c.status === "approved" ? "Approved" : c.status === "declined" ? "Declined" : "Withdrawn"}{c.decidedBy ? ` by ${c.decidedBy}` : ""}{c.decidedAt ? ` · ${dayYear(c.decidedAt)}` : ""}{c.decisionNote ? `: ${c.decisionNote}` : ""}</small> : null}</span>
    {c.status === "pending" ? <span className={css.changeActions}>
      {canDecide ? <><button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} onClick={() => void decide(true)}>Approve</button>
        <RecordForm path={`profile-changes/${c.id}`} extra={{ approve: false }} title={`Decline the ${what.toLowerCase()} change`} label="Decline" variant="ghost" icon="none" action="Decline" done="Declined"
          fields={[{ key: "note", label: "Why (the person sees this)", type: "textarea", required: true }]} /></> : <Badge tone="warning">Waiting for HR</Badge>}
      {me ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => void withdraw()}>Withdraw</button> : null}
    </span> : <Badge tone={c.status === "approved" ? "success" : "neutral"}>{c.status === "approved" ? "Done" : c.status === "declined" ? "Declined" : "Withdrawn"}</Badge>}
  </li>;
}

function BankCard({ data }: { data: MyInfoData }) {
  const router = useRouter();
  const b = data.bankDetails!, me = data.self, first = data.person.firstName, s = b.summary;
  const [editing, setEditing] = useState(false), [shown, setShown] = useState<{ account: string; upi: string | null; at: number } | null>(null), [now, setNow] = useState(0), [busy, setBusy] = useState(false);
  // A revealed number hides itself again after 30 seconds.
  useEffect(() => {
    if (!shown) return;
    const t = window.setInterval(() => { const at = Date.now(); if (at - shown.at >= 30000) setShown(null); else setNow(at); }, 1000);
    return () => window.clearInterval(t);
  }, [shown]);
  const left = shown ? Math.max(0, 30 - Math.floor((Math.max(now, shown.at) - shown.at) / 1000)) : 0;
  async function save(input: BankInput) {
    await post(`onboarding/${data.person.id}/bank`, input);
    setEditing(false); setShown(null);
    notify({ id: "bank", tone: "success", title: me ? "Bank details saved" : `Bank details saved for ${first}`, message: me ? "HR checks them before the next payroll." : `${first} is told in Pulse.`, timeout: 4000 });
    router.refresh();
  }
  async function reveal() {
    setBusy(true);
    try { const r = await post<{ account: string; upi: string | null }>(`people/${data.person.id}/bank/reveal`); const at = Date.now(); setNow(at); setShown({ account: r.account, upi: r.upi, at }); }
    catch (e) { notify({ id: "bank", tone: "error", title: "Not shown", message: message(e) }); } finally { setBusy(false); }
  }
  async function check() {
    setBusy(true);
    try { await post(`people/${data.person.id}/bank/confirm`); notify({ id: "bank", tone: "success", title: "Marked as checked", timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "bank", tone: "error", title: "Not saved", message: message(e) }); } finally { setBusy(false); }
  }
  const status = b.status === "missing" ? { tone: "warning" as const, text: "Not added" } : b.status === "pending" ? { tone: "warning" as const, text: "Waiting for HR’s check" } : { tone: "success" as const, text: "Checked by HR" };
  return <Card id="bank" icon={<Landmark size={16} />} title="Bank for salary" tone={b.status === "missing" ? "attention" : undefined}
    sub={b.status === "missing" ? (me ? "Your salary is paid into this account. Add it once; HR checks it." : `Add ${first}’s salary account, or nudge ${first} from Onboard team.`) : <>Only {me ? "you" : first} and HR see this.</>}
    tools={<Badge tone={status.tone}>{status.tone === "success" ? <BadgeCheck size={11} aria-hidden="true" /> : null}{status.text}</Badge>}>
    {!data.filesReady ? <p className={css.paused}>Bank details are paused on this server: its encryption key isn’t installed yet. Ask the Pulse administrator.</p> : null}
    {s || b.masked ? <dl className={css.rows}>
      {s ? <Row label="Account holder" value={s.holder} /> : null}
      <Row label="Bank" value={s ? [s.bank, s.branch].filter(Boolean).join(" · ") : b.masked} />
      {s ? <Row label="IFSC" value={s.ifsc} mono /> : null}
      <Row label="Account" mono value={<span className={css.inline}>{shown ? shown.account : `•••• •••• ${s?.last4 ?? b.masked?.slice(-4) ?? ""}`}
        {b.canReveal ? <button type="button" className={css.eye} onClick={() => shown ? setShown(null) : void reveal()} disabled={busy || !data.filesReady} aria-label={shown ? "Hide the number" : "Show the full number"} title={shown ? "Hide" : "Show the full number (logged)"}>{shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}</button> : null}
        {shown ? <button type="button" className={css.eye} aria-label="Copy the number" onClick={() => void navigator.clipboard?.writeText(shown.account).then(() => notify({ id: "bank-copy", tone: "success", title: "Copied", timeout: 1500 }))}><Copy size={14} aria-hidden="true" /></button> : null}
        {shown ? <small className={css.muted}>hides in {left}s</small> : null}</span>} />
      {s?.upi || shown?.upi ? <Row label="UPI" value={shown?.upi ?? s?.upi} mono /> : null}
    </dl> : <p className={css.muted}>{me ? "No bank details yet." : `${first} hasn’t added bank details yet.`}</p>}
    {b.updatedAt ? <p className={css.meta}>{b.source === "hr" ? `Entered by ${b.updatedBy ?? "HR"}` : `Entered by ${me ? "you" : first}`} · {dayYear(b.updatedAt)}{b.checkedAt ? ` · checked by ${b.checkedBy ?? "HR"} ${dayYear(b.checkedAt)}` : ""}</p> : null}
    <div className={css.cardActions}>
      {b.canEdit ? <button type="button" className={`${styles.btn}${b.status === "missing" ? ` ${styles.btnPrimary}` : ""}`} disabled={!data.filesReady} onClick={() => setEditing(true)}>{b.status === "missing" ? "Add bank details" : "Change"}</button> : null}
      {b.canCheck ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void check()}><BadgeCheck size={14} aria-hidden="true" />Mark as checked</button> : null}
    </div>
    {editing ? <Modal title={b.status === "missing" ? "Add bank details" : "Change bank details"} sub={me ? "Your salary is paid into this account." : `For ${data.person.name}’s salary.`} onClose={() => setEditing(false)} scroll>
      <div className={css.modalPad}><BankForm holder={s?.holder ?? data.person.name} onSave={save} onCancel={() => setEditing(false)}
        note={me ? "Encrypted as soon as you save. Pulse then shows only the bank and the last four digits. HR checks the details before the next payroll and opens the full number only to pay you; every opening is logged."
          : `Encrypted as soon as you save. ${first} is told that HR changed them, and the change is logged.`} /></div>
    </Modal> : null}
  </Card>;
}
