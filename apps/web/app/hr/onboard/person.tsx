"use client";
// One person's onboarding as HR sees it: what is missing, their details (HR with the contact permission), masked ID
// numbers and files (only the HR role or someone granted the HR documents permission; every look is logged and the
// person sees the log), agents' proposals with their source, and "fill in for them".
import { Check, ExternalLink, FileText, ShieldAlert, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { notify } from "@pulse/ui-shell";
import { day } from "../../lib/format";
import { Modal, post } from "../../records";
import { Badge, styles } from "../../ui";
import type { OnboardingState } from "../../welcome/types";
import { missingText } from "../../welcome/types";
import type { DocKindSetting, OnboardPerson } from "./types";
import css from "./onboard.module.css";

const DETAIL: [string, string][] = [["dob", "Date of birth"], ["personalPhone", "Personal phone"], ["personalEmail", "Personal email"], ["address", "Address"], ["city", "City"], ["pincode", "PIN"],
  ["emergencyName", "Emergency contact"], ["emergencyRelation", "Relation"], ["emergencyPhone", "Emergency phone"]];
const FIELD: Record<string, string> = Object.fromEntries([...DETAIL, ["joinedOn", "Joined on"], ["department", "Department"], ["document", "Document"]]);

export function OnboardPersonView({ person, kinds, canEdit, onClose, onNudge }: { person: OnboardPerson; kinds: DocKindSetting[]; canEdit: boolean; onClose: () => void; onNudge: (kind: "checkin" | "profile" | "bank") => void }) {
  const router = useRouter();
  const [s, setS] = useState<OnboardingState | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [reject, setReject] = useState<string | null>(null); const [note, setNote] = useState("");
  const load = () => fetch(`/api/v0/onboarding/${person.id}`, { cache: "no-store" }).then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.error); setS(b); }).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, [person.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function act(path: string, body: unknown, done: string) {
    setBusy(true);
    try { await post(path, body); notify({ id: path, tone: "success", title: done, timeout: 2500 }); await load(); router.refresh(); }
    catch (e) { notify({ id: path, tone: "error", title: "Not saved", message: (e as Error).message }); } finally { setBusy(false); }
  }
  return (
    <Modal title={person.name} sub={[person.role, person.pod, person.joinedOn ? `joined ${day(person.joinedOn)}` : null].filter(Boolean).join(" · ")} onClose={onClose} scroll
      foot={<div className={styles.modalFoot} style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>{canEdit ? <><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onNudge("profile")}>Nudge to finish profile</button>
        {!person.firstCheckIn && !person.outcome ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onNudge("checkin")}>Nudge to check in</button> : null}
        {person.bank === "missing" || !person.bank ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onNudge("bank")}>Nudge for bank details</button> : null}</> : null}
        <Link href={`/people/${person.id}?tab=info`} className={`${styles.btn} ${styles.btnSmall}`}>Personal info{person.bank === "pending" ? ": check bank" : ""}</Link>
        <Link href={`/welcome?person=${person.id}`} className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`}>Fill in for them</Link></div>}>
      <div className={`${styles.modalBody} ${css.person}`}>
        {error ? <p role="alert">{error}</p> : !s ? <p className={styles.muted}>Loading…</p> : <>
          <p className={css.personLine}><b>{s.percent}% complete</b>{s.missing.length ? <span> · still missing: {missingText(s)}</span> : <span> · nothing missing</span>}</p>
          <section aria-label="Documents"><h3>Documents</h3>
            {!s.canSeeIds ? <p className={styles.muted}>You see only whether each document is on file. Numbers and files are for the person and HR.</p> : <p className={styles.muted}>Opening a file is logged on {s.person.firstName}’s HR record.</p>}
            {s.filesReady === false ? <p className={styles.banner} role="status"><ShieldAlert size={14} aria-hidden="true" /><span>Files can’t be uploaded or opened until the Pulse administrator installs this server’s document encryption key.</span></p> : null}
            <ul className={css.docList}>{s.documents.map((d) => <li key={d.kind}>
              <span className={css.docName}><b>{d.label}</b>{d.document ? <small>{d.document.source === "drive" ? `In HR’s Drive · ${d.document.drive ?? ""}` : `${d.document.source === "hr" ? "Added by HR" : "Added by them"} · ${day(d.document.addedAt)}`}</small> : <small>{d.required ? "Needed" : "Optional"}</small>}</span>
              {d.document?.masked ? <code className={css.masked}>{d.document.masked}</code> : null}
              {d.document ? <Badge tone={d.document.status === "verified" ? "success" : d.document.status === "rejected" ? "warning" : "neutral"}>{d.document.status === "verified" ? "Checked" : d.document.status === "rejected" ? "New one asked" : "On file"}</Badge> : <Badge tone="warning">Missing</Badge>}
              {d.document && s.canSeeIds ? <span className={css.docTools}>
                {d.document.hasFile && s.filesReady !== false ? <a className={`${styles.btn} ${styles.btnSmall}`} href={`/api/v0/onboarding/documents/${d.document.id}/file`} target="_blank" rel="noreferrer"><FileText size={12} aria-hidden="true" />Open</a> : null}
                {d.document.status !== "verified" ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void act(`onboarding/documents/${d.document!.id}/check`, { ok: true }, `${d.label} checked`)}><Check size={12} aria-hidden="true" />Checked</button> : null}
                {d.document.status !== "rejected" ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => { setReject(d.document!.id); setNote(""); }}><X size={12} aria-hidden="true" />Ask for a new one</button> : null}
              </span> : null}
              {reject === d.document?.id ? <form className={css.reject} onSubmit={(e) => { e.preventDefault(); void act(`onboarding/documents/${reject}/check`, { ok: false, note }, "Asked for a new one").then(() => setReject(null)); }}>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is wrong, e.g. the photo is blurred" minLength={3} required aria-label="What is wrong" />
                <button className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy}>Send</button>
              </form> : null}
            </li>)}</ul>
          </section>
          {s.proposals.length ? <section aria-label="Suggestions"><h3>Suggestions to confirm</h3>
            <p className={styles.muted}>Pulse’s agents found these in HR’s own records. Nothing is used until a person confirms. ID numbers are never copied: a document suggestion only points at a file in Drive.</p>
            <ul className={css.docList}>{s.proposals.map((p) => <li key={p.id}>
              <span className={css.docName}><b>{FIELD[p.field] ?? p.field}{p.documentKind ? `: ${kinds.find((k) => k.kind === p.documentKind)?.label ?? p.documentKind}` : ""}</b><small>{p.value ? `${p.value} · ` : ""}from {p.sourceLabel}</small></span>
              <span className={css.docTools}>
                <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void act(`onboarding/proposals/${p.id}`, { accept: true }, "Confirmed")}>Confirm</button>
                <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void act(`onboarding/proposals/${p.id}`, { accept: false }, "Rejected")}>Not right</button>
              </span>
            </li>)}</ul>
          </section> : null}
          <section aria-label="Details"><h3>Details</h3>
            {s.details ? <dl className={css.details}>{DETAIL.map(([k, l]) => <div key={k}><dt>{l}</dt><dd>{s.details?.[k] || <span className={styles.muted}>–</span>}</dd></div>)}
              <div><dt>Bank for salary</dt><dd>{s.bank ?? <span className={styles.muted}>{person.bank && person.bank !== "missing" ? "On file (HR role only)" : "–"}</span>}{s.bank && person.bank === "pending" ? <> <Badge tone="warning">To check</Badge></> : null}</dd></div></dl>
              : <p className={styles.muted}>Personal details are visible to HR with the contact permission.</p>}
          </section>
          <section aria-label="Pulse"><h3>Pulse</h3>
            <dl className={css.details}>
              <div><dt>Signed in</dt><dd>{person.signedInAt ? day(person.signedInAt) : "Not yet"}</dd></div>
              <div><dt>Apps</dt><dd>{[person.apps?.phone && "Phone", person.apps?.desktop && "Computer", person.apps?.chrome && "Chrome"].filter(Boolean).join(", ") || "None yet"}</dd></div>
              <div><dt>First check-in</dt><dd>{person.firstCheckIn ? day(person.firstCheckIn) : "Never"}</dd></div>
              <div><dt>Office arrival</dt><dd>{person.consent ? "Agreed" : "Not agreed"}</dd></div>
            </dl>
            <p className={styles.muted}><Link href={`/people/${person.id}?tab=attendance`}>Attendance <ExternalLink size={11} aria-hidden="true" /></Link></p>
          </section>
        </>}
      </div>
    </Modal>
  );
}
